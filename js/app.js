/**
 * GOELink Application Entry Point
 */

const App = {
    // Core State
    state: {
        user: null, // Auth User Object
        role: null, // 'admin' | 'teacher'
        status: null, // 'active' | 'pending'
        currentYear: new Date().getFullYear(),
        viewMode: 'calendar', // 'calendar', 'list'
        listViewStart: null, // Start Date of current list week view
        departments: [], // Cached Departments
        templates: {}, // Cached Modal Templates
    },

    // Constants
    SPECIAL_DEPTS: [
        { id: 'admin_office', name: '행정실' },
        { id: 'advanced_teacher', name: '수석' },
        { id: 'vice_principal', name: '교감' },
        { id: 'principal', name: '교장' },
    ],

    FIXED_ENV_EVENTS: {
        "02-02": "세계 습지의 날",
        "03-22": "세계 물의 날",
        "04-05": "식목일",
        "04-22": "지구의 날",
        "05-22": "생물종다양성 보존의 날",
        "06-05": "환경의 날",
        "08-22": "에너지의 날",
        "09-06": "자원순환의 날",
        "09-16": "세계 오존층 보호의 날",
    },

    // --- Shared Date Logic (Holiday Aware & Timezone Safe) ---
    parseLocal: function (s) {
        if (!s) return null;
        const parts = s.split('-').map(Number);
        return new Date(parts[0], parts[1] - 1, parts[2]);
    },

    formatLocal: function (d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    },

    isSchoolDay: function (d, parsedHolidays = null) {
        const day = d.getDay(); // Local day (0-6)
        if (day === 0 || day === 6) return false; // Weekend

        const dStr = this.formatLocal(d);

        // Priority 1: Check passed list (e.g. from Excel parsing)
        if (parsedHolidays) {
            const isParsed = parsedHolidays.some(p => p.is_holiday && p.start_date <= dStr && p.end_date >= dStr);
            if (isParsed) return false;
        }

        // Priority 2: Check App State (Admin View)
        // Fixed Holidays
        if (this.currentFixedHolidays && this.currentFixedHolidays[dStr]) return false;
        // Variable Holidays
        if (this.currentVariableHolidays && this.currentVariableHolidays.some(h => h.date === dStr)) return false;

        return true;
    },

    findPrevSchoolDay: function (startDateStr, parsedHolidays = null) {
        let d = this.parseLocal(startDateStr);
        d.setDate(d.getDate() - 1);
        let safety = 0;
        while (safety < 30) {
            if (this.isSchoolDay(d, parsedHolidays)) return this.formatLocal(d);
            d.setDate(d.getDate() - 1);
            safety++;
        }
        return startDateStr;
    },

    findNextSchoolDay: function (endDateStr, parsedHolidays = null) {
        let d = this.parseLocal(endDateStr);
        d.setDate(d.getDate() + 1);
        let safety = 0;
        while (safety < 30) {
            if (this.isSchoolDay(d, parsedHolidays)) return this.formatLocal(d);
            d.setDate(d.getDate() + 1);
            safety++;
        }
        return endDateStr;
    },

    // Initialization
    init: async function () {
        console.log("GOELink Initializing...");

        try {
            // 1. Initialize Supabase
            if (window.SupabaseClient) {
                await window.SupabaseClient.init();
            } else {
                throw new Error("Supabase Client not loaded.");
            }

            // 2. Check Auth State
            await this.checkAuth();

            // 3. Routing & History Setup
            window.addEventListener('popstate', (event) => {
                // Handle Back/Forward Button
                const viewName = event.state?.view || 'calendar';
                // Update internal state directly to avoid recursion or double-pushing
                this.state.viewMode = viewName;
                localStorage.setItem('pogok_last_view', viewName);
                this.loadView(viewName);
            });

            // 4. Load Initial View
            // Force 'calendar' on root load (ignore localStorage to prevent auto-redirect to dept_list etc for guests)
            let initialView = 'calendar'; 

            if (window.location.hash) {
                const hashView = window.location.hash.substring(1);
                // Allow dept_list explicitly in hash handling
                if (['calendar', 'login', 'admin', 'dept_list'].includes(hashView)) {
                    initialView = hashView;
                }
            }

            // Replace current state (initial load) - Keep URL clean
            // If we loaded from a hash, we consume it and clean the URL
            history.replaceState({ view: initialView }, '', window.location.pathname);
            this.navigate(initialView, true); // true = replace (don't push again)

            console.log("GOELink Ready.");
        } catch (error) {
            console.error("Initialization Failed:", error);
            alert("시스템 초기화 중 오류가 발생했습니다: " + error.message);
        } finally {
            // 5. Remove Loader (Always run)
            document.getElementById('loading-spinner').classList.add('hidden');
            document.getElementById('view-container').classList.remove('hidden');
        }
    },

    // Helper: Capture Current Date from Active View
    captureCurrentDate: function() {
        // If we are currently in a view, capture its date to state
        if (this.state.viewMode === 'calendar' && this.state.calendar) {
            return this.state.calendar.getDate();
        } 
        if (this.state.viewMode === 'dept_list' && this.state.deptViewDate) {
            return new Date(this.state.deptViewDate);
        }
        if (this.state.viewMode === 'list' && this.state.listViewStart) {
            // Use the Representative Date (e.g. Wednesday of the week)
            // so if we switch to month view, we land on the correct month
            const d = new Date(this.state.listViewStart);
            d.setDate(d.getDate() + 3);
            return d;
        }
        return new Date(); // Default to Now
    },

    navigate: function (viewName, replace = false) {
        // [SYNC] Capture date from current view before switching
        const sharedDate = this.captureCurrentDate();

        // [SYNC] Propagate to Target View State
        if (viewName === 'calendar') {
            this.state.initialDate = sharedDate;
        } else if (viewName === 'dept_list') {
            // Set 1st of month for Dept View logic usually, but specific date is fine
            this.state.deptViewDate = sharedDate;
        } else if (viewName === 'list') {
            // Calculate Monday of the week containing sharedDate
            const d = new Date(sharedDate);
            const day = d.getDay();
            const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust to Monday
            this.state.listViewStart = new Date(d.setDate(diff));
            this.state.listViewWeeks = this.state.listViewWeeks || 1; // Maintain week count preference
        }

        this.state.viewMode = viewName;
        localStorage.setItem('pogok_last_view', viewName);

        if (replace) {
            history.replaceState({ view: viewName }, '', window.location.pathname);
        } else {
            history.pushState({ view: viewName }, '', window.location.pathname);
        }

        this.loadView(viewName);
    },

    checkAuth: async function () {
        try {
            const { data, error } = await window.SupabaseClient.supabase.auth.getSession();
            if (error) throw error;

            await this.syncUser(data.session?.user);
            this.updateAuthUI(data.session);
        } catch (e) {
            console.error("checkAuth: Error getting session", e);
        }

        // Listen for auth changes
        window.SupabaseClient.supabase.auth.onAuthStateChange(async (_event, session) => {
            await this.syncUser(session?.user);
            this.updateAuthUI(session);
            // Redirect to calendar if logged in from login page
            if (session && this.state.viewMode === 'login') {
                this.navigate('calendar');
            }
        });
    },

    // Sync User with DB (Upsert & Fetch Role)
    syncUser: async function (authUser) {
        if (!authUser) {
            this.state.user = null;
            this.state.role = null;
            this.state.status = null;
            return;
        }

        try {
            // 1. Sync User Info (Upsert)
            // We lazily create the user_role entry on login if it doesn't exist
            const { error: upsertError } = await window.SupabaseClient.supabase
                .from('user_roles')
                .upsert({
                    user_id: authUser.id,
                    email: authUser.email,
                    last_login: new Date().toISOString()
                }, { onConflict: 'user_id' });

            if (upsertError) {
                console.warn("User Synced failed (Table might not exist yet?):", upsertError);
            }

            // 2. Fetch Role Info
            const { data, error: fetchError } = await window.SupabaseClient.supabase
                .from('user_roles')
                .select('role, status')
                .eq('user_id', authUser.id)
                .single();

            this.state.user = authUser;

            if (data) {
                this.state.role = data.role;
                this.state.status = data.status;
            } else {
                // Default fallback if fetch failed or just inserted
                this.state.role = 'teacher';
                this.state.status = 'pending';
            }

            console.log(`User: ${authUser.email}, Role: ${this.state.role}, Status: ${this.state.status}`);

        } catch (e) {
            console.error("Sync Logic Error:", e);
            // Fallback
            this.state.user = authUser;
            this.state.role = 'teacher';
        }
    },

    updateAuthUI: function (session) {
        // State is already updated by syncUser, but we ensure consistency
        if (!this.state.user && session?.user) this.state.user = session.user;

        const authContainer = document.getElementById('auth-status');

        if (!authContainer) {
            console.error("updateAuthUI: 'auth-status' element not found!");
            return;
        }

        if (this.state.user) {
            const userEmail = this.state.user.email.split('@')[0];
            const adminBtn = this.state.role === 'admin'
                ? `<button id="btn-admin" class="text-sm px-3 py-1 border border-purple-200 text-purple-700 rounded bg-purple-50 hover:bg-purple-100 ml-2">관리자</button>`
                : '';

            authContainer.innerHTML = `
                <span class="text-sm text-gray-700 hidden sm:inline">안녕하세요, <strong>${userEmail}</strong>님</span>
                ${adminBtn}
                <button id="btn-logout" class="text-sm px-3 py-1 border border-gray-300 rounded hover:bg-gray-100 ml-2">로그아웃</button>
            `;

            document.getElementById('btn-logout').addEventListener('click', async () => {
                await window.SupabaseClient.supabase.auth.signOut();
                this.navigate('calendar');
                window.location.reload(); // Clean state
            });

            if (this.state.role === 'admin') {
                document.getElementById('btn-admin').addEventListener('click', () => {
                    this.navigate('admin');
                });
            }
        } else {
            authContainer.innerHTML = `
                <button id="btn-login" class="text-sm font-medium text-gray-600 hover:text-gray-900">로그인</button>
            `;
            document.getElementById('btn-login').addEventListener('click', () => {
                this.navigate('login');
            });
        }

        // Update other UI elements based on role
        this.updateAccessControls();
    },

    updateAccessControls: function () {
        // "Add Schedule" Button Visibility
        // Visible for: Admin, Head Teacher
        // Hidden for: Teacher, Guest
        const btnAddSchedule = document.getElementById('btn-add-schedule');

        if (btnAddSchedule) {
            const canAdd = this.state.role === 'admin' || this.state.role === 'head_teacher' || this.state.role === 'head';

            if (canAdd) {
                btnAddSchedule.classList.remove('hidden');
            } else {
                btnAddSchedule.classList.add('hidden');
            }
        }
    },

    loadView: async function (viewName) {
        const container = document.getElementById('view-container');

        // Cleanup content
        container.innerHTML = '';

        // Mobile Calendar Button Layout Hook
        // Adds a class to body so CSS can adjust header button spacing dynamically
        if (viewName === 'list' || viewName === 'dept_list') {
            document.body.classList.add('view-has-calendar-btn');
        } else {
            document.body.classList.remove('view-has-calendar-btn');
        }

        if (viewName === 'calendar') {
            try {
                const response = await fetch('pages/calendar.html');
                const html = await response.text();
                container.innerHTML = html;
                this.initCalendar();
            } catch (e) {
                console.error("Failed to load calendar", e);
                container.innerHTML = `<p class="text-red-500">캘린더 로딩 실패</p>`;
            }
        } else if (viewName === 'list') {
            try {
                const response = await fetch('pages/list.html');
                const html = await response.text();
                container.innerHTML = html;
                this.initListView();
            } catch (e) {
                console.error("Failed to load list view", e);
                container.innerHTML = `<p class="text-red-500">목록 로딩 실패</p>`;
            }
        } else if (viewName === 'dept_list') {
            try {
                const response = await fetch('pages/dept-list.html');
                const html = await response.text();
                container.innerHTML = html;
                this.initDeptListView();
            } catch (e) {
                console.error("Failed to load dept list view", e);
                container.innerHTML = `<p class="text-red-500">부서별 보기 로딩 실패</p>`;
            }
        } else if (viewName === 'login') {
            try {
                const response = await fetch('pages/login.html');
                const html = await response.text();
                container.innerHTML = html;
                this.initLoginView();
            } catch (e) {
                console.error("Failed to load login page", e);
                container.innerHTML = "<p class='text-red-500'>페이지를 불러올 수 없습니다.</p>";
            }
        } else if (viewName === 'admin') {
            // Check Admin Auth (Simple client-side check, real security via RLS)
            if (!this.state.user || this.state.role !== 'admin') {
                alert("접근 권한이 없습니다.");
                this.navigate('calendar'); // Redirect to calendar instead of login if already logged in but not admin
                return;
            }

            try {
                const response = await fetch('pages/admin.html');
                const html = await response.text();
                container.innerHTML = html;
                this.initAdminView();
            } catch (e) {
                console.error("Failed to load admin page", e);
                container.innerHTML = "<p class='text-red-500'>페이지를 불러올 수 없습니다.</p>";
            }
        }

        // Re-run Auth UI update to bind header buttons if they exist
        // This is crucial because header buttons might be part of the layout, 
        // but if we have view-specific buttons (like in login page), they need specific init.
        // Actually, header is static. But `btn-login` might be in header.

        // Safety check: ensure header auth UI is consistent
        this.updateAuthUI(this.state.user ? { user: this.state.user } : null);
    },

    initLoginView: function () {
        const form = document.getElementById('login-form');
        const errorMsg = document.getElementById('login-error');
        const DOMAIN = 'pogok.hs.kr'; // Default domain for short IDs

        form.onsubmit = async (e) => {
            e.preventDefault();
            let email = document.getElementById('email').value.trim();
            const password = document.getElementById('password').value;
            const btn = document.getElementById('btn-login-submit');

            // Auto-append domain if not present
            if (!email.includes('@')) {
                email = `${email}@${DOMAIN}`;
            }

            btn.disabled = true;
            btn.innerHTML = '로그인 중...';
            errorMsg.classList.add('hidden');

            try {
                const { data, error } = await window.SupabaseClient.supabase.auth.signInWithPassword({
                    email,
                    password
                });

                if (error) throw error;
                // Auth State Change listener will handle redirect
            } catch (err) {
                errorMsg.textContent = '로그인 실패: 이메일 또는 비밀번호를 확인하세요.';
                errorMsg.classList.remove('hidden');
                btn.disabled = false;
                btn.innerHTML = '로그인';
            }
        };
    },

    initAdminView: async function () {
        // 0. Ensure Settings/Departments Loaded for target year
        const yearSelect = document.getElementById('setting-academic-year');

        // Dynamic Year Dropdown Generation
        if (yearSelect) {
            const currentYear = new Date().getFullYear();
            const startYear = currentYear - 5;
            const endYear = currentYear + 5;
            yearSelect.innerHTML = '';
            for (let y = startYear; y <= endYear; y++) {
                const opt = document.createElement('option');
                opt.value = y;
                opt.textContent = `${y}학년도`;
                if (y === currentYear) opt.selected = true;
                yearSelect.appendChild(opt);
            }
        }

        const currentSelectedYear = yearSelect ? parseInt(yearSelect.value) : new Date().getFullYear();

        const settings = await this.fetchSettings(currentSelectedYear);
        this.state.departments = await this.fetchDepartments();

        const setVal = (id, val) => {
            const el = document.getElementById(id);
            if (el) {
                // If the field is currently in manual mode, don't overwrite
                if (el.dataset.manual === 'true') return;

                el.value = val;
                // Dispatch event so cascading formulas trigger
                el.dispatchEvent(new Event('change'));
            }
        };

        const formatDate = (date) => {
            if (!date || isNaN(date.getTime())) return '';
            const y = date.getFullYear();
            const m = String(date.getMonth() + 1).padStart(2, '0');
            const d = String(date.getDate()).padStart(2, '0');
            return `${y}-${m}-${d}`;
        };

        const addDays = (dateStr, days) => {
            if (!dateStr) return '';
            if (dateStr.length < 10) return '';
            const d = new Date(dateStr);
            if (isNaN(d.getTime())) return '';
            d.setDate(d.getDate() + days);
            return formatDate(d);
        };

        const triggerYearSmartCalc = (year) => {
            if (!year) return;

            // Collect Variable Holidays from UI for immediate calculation
            const holidayDates = [];
            document.querySelectorAll('.holiday-date').forEach(inp => {
                if (inp.value) holidayDates.push(inp.value);
            });

            // 1. 1st Semester Start: First weekday of March
            // March 1st is fixed holiday (Sam-il-jeol)
            let d = new Date(year, 2, 1);
            d.setDate(2); // Start searching from March 2nd

            const isNonSchoolDay = (dateObj) => {
                const day = dateObj.getDay();
                if (day === 0 || day === 6) return true; // Weekend
                const dateStr = formatDate(dateObj);
                const mmdd = dateStr.split('-').slice(1).join('');
                if (this.currentFixedHolidays && this.currentFixedHolidays[mmdd]) return true; // Fixed holiday
                if (holidayDates.includes(dateStr)) return true; // Variable/Manual holiday
                return false;
            };

            while (isNonSchoolDay(d)) {
                d.setDate(d.getDate() + 1);
            }
            setVal('sched-sem1-start', formatDate(d));

            // 2. Winter Vacation End: Last day of February of the NEXT year
            const febYear = parseInt(year) + 1;
            let lastFeb = new Date(febYear, 2, 0);
            setVal('sched-winter-end', formatDate(lastFeb));
        };

        this.triggerSmartCalc = () => {
            const y = yearSelect ? yearSelect.value : null;
            if (y) triggerYearSmartCalc(y);
        };

        // --- Manual Override Tracker ---
        // Any manual input by the user on these fields should set the manual flag
        const schedIds = [
            'sched-sem1-start', 'sched-summer-start-ceremony', 'sched-summer-start',
            'sched-summer-end', 'sched-sem2-start', 'sched-winter-start-ceremony',
            'sched-winter-start', 'sched-winter-end', 'sched-spring-sem-start',
            'sched-spring-start-ceremony', 'sched-spring-start', 'sched-spring-end'
        ];
        schedIds.forEach(id => {
            document.getElementById(id)?.addEventListener('input', (e) => {
                e.target.dataset.manual = 'true';
            });
        });

        // --- Manual Override Handler (Alert for Readonly fields) ---
        document.querySelectorAll('input[readonly][data-hint]').forEach(el => {
            el.addEventListener('click', () => {
                if (el.readOnly && el.dataset.manual !== 'true') {
                    const hintName = el.dataset.hint || "기간";
                    if (confirm(`${hintName}을(를) 입력하면 자동으로 입력됩니다. 수동 입력하시겠습니까?`)) {
                        el.readOnly = false;
                        el.dataset.manual = 'true';
                        el.classList.remove('bg-gray-100');
                        el.classList.add('bg-white');
                        el.focus();
                    }
                }
            });
        });

        // 1. Department Management (General)
        // Note: Department Rendering is handled by populateAdminForm to ensure state sync.
        // We only prepare the container and buttons here.
        const deptList = document.getElementById('admin-dept-list');
        const btnAddDeptSlot = document.getElementById('btn-add-dept-slot');
        const btnSaveDept = document.getElementById('btn-save-depts');

        if (btnAddDeptSlot) {
            btnAddDeptSlot.onclick = () => {
                const row = document.createElement('div');
                row.className = "flex items-center gap-2 mb-2";
                row.innerHTML = `
                    <input type="text" placeholder="부서명" class="dept-name-input border rounded px-2 py-1 w-48" />
                    <input type="color" value="#3788d8" class="dept-color-input border rounded h-8 w-8 cursor-pointer" />
                    <button class="btn-delete-dept text-red-500 hover:text-red-700">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                    </button>
                `;
                deptList.appendChild(row);
                row.querySelector('.btn-delete-dept').onclick = () => row.remove();
            };
        }

        if (btnSaveDept) {
            btnSaveDept.onclick = async () => {
                await this.handleSaveSettings(); // Department config is saved within settings for multi-year
            };
        }

        // 2. Schedule Settings Loading
        // We use loadAndPopulate to handle year switching
        const loadAndPopulate = async (y = null) => {
            const settings = await this.fetchSettings(y);
            const isNewYear = !settings || !settings.id; // Detect new by missing ID

            // Alert for new year (only if specifically requested via switching)
            if (y && isNewYear) {
                alert(`${y}학년도를 처음 설정하려고 합니다.\n날짜를 검토 후, '학년도 및 기본 학사 일정 저장', '부서 설정 저장' 버튼을 눌러주세요.`);
            }

            this.populateAdminForm(settings, y);

            // Smart Calc for Year-based dates (Only for NEW years to avoid overwrite)
            const selectedYear = y || (yearSelect ? yearSelect.value : null);
            if (selectedYear && isNewYear) {
                triggerYearSmartCalc(selectedYear);
            }
        };

        // Expose for external calls (e.g. from Excel Modal)
        this.refreshAdminView = loadAndPopulate;

        await loadAndPopulate(); // Initial load

        // Academic Year Change Listener (Manual Confirm)
        const btnChangeYear = document.getElementById('btn-change-year');
        if (btnChangeYear && yearSelect) {
            btnChangeYear.onclick = async () => {
                const newYear = parseInt(yearSelect.value);
                if (confirm(`${newYear}학년도로 전환하시겠습니까?\n저장하지 않은 내용은 사라질 수 있습니다.`)) {
                    await loadAndPopulate(newYear);
                }
            };
        }

        // School Level Sync (KR -> EN)
        const krLevelSelect = document.getElementById('setting-school-level-kr');
        const enLevelSelect = document.getElementById('setting-school-level-en');
        if (krLevelSelect && enLevelSelect) {
            krLevelSelect.addEventListener('change', () => {
                const map = {
                    '초등학교': 'Elementary School',
                    '중학교': 'Middle School',
                    '고등학교': 'High School',
                    '특수학교': 'School',
                    '학교': 'School'
                };
                const val = map[krLevelSelect.value];
                if (val) enLevelSelect.value = val;
            });
            enLevelSelect.addEventListener('change', () => {
                const revMap = {
                    'Elementary School': '초등학교',
                    'Middle School': '중학교',
                    'High School': '고등학교',
                    'School': '학교'
                };
                const val = revMap[enLevelSelect.value];
                if (val) krLevelSelect.value = val;
            });
        }

        // 4. Dept Import Trigger
        const btnImportTrigger = document.getElementById('btn-import-depts-trigger');
        if (btnImportTrigger) {
            btnImportTrigger.onclick = () => this.openDeptImportModal();
        }

        // --- Shared Date Logic (Holiday Aware) ---
        // Moved to App methods (this.parseLocal, etc.)

        // Date Cascading Listeners (Updated to use Smart Logic)
        document.getElementById('sched-summer-start')?.addEventListener('change', (e) => {
            setVal('sched-summer-start-ceremony', this.findPrevSchoolDay(e.target.value));
        });
        document.getElementById('sched-summer-end')?.addEventListener('change', (e) => {
            setVal('sched-sem2-start', this.findNextSchoolDay(e.target.value));
        });
        document.getElementById('sched-winter-start')?.addEventListener('change', (e) => {
            setVal('sched-winter-start-ceremony', this.findPrevSchoolDay(e.target.value));
        });
        document.getElementById('sched-winter-end')?.addEventListener('change', (e) => {
            const val = e.target.value;
            if (!val) return;
            // Special check for Spring Sem Start
            const nextDay = this.findNextSchoolDay(val);
            const nDate = this.parseLocal(nextDay);

            // If next school day is March, it's Term 1 Start, not Spring Sem Start
            if (nDate.getMonth() === 2) {
                setVal('sched-spring-sem-start', '');
            } else {
                setVal('sched-spring-sem-start', nextDay);
            }
        });
        document.getElementById('sched-spring-start')?.addEventListener('change', (e) => {
            const val = e.target.value;
            setVal('sched-spring-start-ceremony', this.findPrevSchoolDay(val));

            if (val) {
                const d = this.parseLocal(val);
                // Default Spring Vac End to Last day of Feb
                const lastFeb = new Date(d.getFullYear(), 2, 0);
                setVal('sched-spring-end', this.formatLocal(lastFeb));
            }
        });

        // Variable Holidays Container
        const container = document.getElementById('variable-holidays-container');
        if (container) {
            container.addEventListener('change', (e) => {
                if (e.target.classList.contains('holiday-date')) {
                    this.triggerSmartCalc();
                }
            });
        }

        const btnAddHol = document.getElementById('btn-add-holiday');
        if (btnAddHol) {
            btnAddHol.onclick = () => {
                this.syncVariableHolidaysFromUI(); // State-sync first
                if (!this.currentVariableHolidays) this.currentVariableHolidays = [];
                this.currentVariableHolidays.push({ date: '', name: '' });
                this.renderVariableHolidays(this.currentVariableHolidays);
            };
        }

        // Major Events Container
        const majorContainer = document.getElementById('major-events-container');
        if (majorContainer) {
            majorContainer.addEventListener('change', (e) => {
                if (e.target.classList.contains('event-date')) {
                    // triggerSmartCalc(); // Not needed for pure events
                }
            });
        }

        const btnAddMajor = document.getElementById('btn-add-major-event');
        if (btnAddMajor) {
            btnAddMajor.onclick = () => {
                this.syncMajorEventsFromUI();
                if (!this.currentMajorEvents) this.currentMajorEvents = [];
                this.currentMajorEvents.push({ start: '', end: '', name: '' });
                this.renderMajorEvents(this.currentMajorEvents);

                // Scroll to bottom
                requestAnimationFrame(() => {
                    const container = document.getElementById('major-events-container');
                    if (container) {
                        container.scrollTop = container.scrollHeight;
                    }
                });
            };
        }

        // Save Settings (Main Button)
        const btnSaveSettings = document.getElementById('btn-save-settings');
        if (btnSaveSettings) {
            btnSaveSettings.onclick = async () => {
                await this.handleSaveSettings();
            };
        }

        // Save School Info (New Button)
        const btnSaveSchoolInfo = document.getElementById('btn-save-school-info');
        if (btnSaveSchoolInfo) {
            btnSaveSchoolInfo.onclick = async () => {
                await this.handleSaveSchoolInfo();
            };
        }

        // Load Admin Users List
        this.loadAdminUsers();
    },

    populateAdminForm: async function (settings, targetYear) {
        const data = settings || {};
        // Removed schedule_data and department_config dependency

        // 1. Academic Year Dropdown
        const yearSelect = document.getElementById('setting-academic-year');
        if (yearSelect) {
            const y = targetYear || data.academic_year || new Date().getFullYear();
            this.state.currentYear = y;

            // Refresh Departments for this year to avoid duplicates/stale data
            this.state.departments = await this.fetchDepartments(y);
        }

        // --- Helper for setting values ---
        const setVal = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.value = val || '';
        };

        // 2. School Info
        // The form now loads the "pure" school name from 'school_name' field.
        // 'full_name_kr' is reserved for the concatenated display version used in the header/print.
        setVal('setting-school-name-kr', data.school_name || '');

        setVal('setting-school-name-en', data.name_en || '');
        setVal('setting-school-level-kr', data.level_kr || '');
        setVal('setting-school-level-en', data.level_en || '');

        // 3. Departments
        const deptList = document.getElementById('admin-dept-list');
        if (deptList) {
            deptList.innerHTML = '';

            // Filter DB departments into General vs Special
            const allDepts = this.state.departments || [];
            const specNames = this.SPECIAL_DEPTS.map(s => s.name);

            const genDepts = allDepts
                .filter(d => !specNames.includes(d.dept_name))
                // Deduplicate by Name (Fix for dirty DB data)
                .filter((d, index, self) =>
                    index === self.findIndex((t) => (
                        t.dept_name === d.dept_name
                    ))
                )
                .map(d => ({
                    id: d.id, // Store ID for stable update
                    name: d.dept_name,
                    nickname: d.dept_short,
                    color: d.dept_color
                }));

            // Safe Colors
            const safeColors = ['#3b82f6', '#0ea5e9', '#06b6d4', '#14b8a6', '#10b981', '#64748b', '#6366f1', '#8b5cf6', '#71717a', '#4b5563'];

            const renderRow = (d, index) => {
                const row = document.createElement('div');
                row.className = "flex items-center gap-2 mb-2 dept-row";
                if (d.id) row.dataset.id = d.id; // Store ID for persistence

                const defaultColor = safeColors[index % safeColors.length];

                let color = d.color || defaultColor;
                let name = d.name || '';
                let nickname = d.nickname || '';
                if (!nickname && name) {
                    nickname = name.substring(0, 2);
                }

                row.innerHTML = `
                     <input type="text" value="${name}" class="dept-name-input border rounded px-2 py-1 w-48 focus:ring-2 focus:ring-purple-200" placeholder="부서명" />
                     <input type="text" value="${nickname}" class="dept-nickname-input border rounded px-2 py-1 w-16 text-center text-sm focus:ring-2 focus:ring-purple-200" placeholder="약어" maxlength="3" />
                     <input type="color" value="${color}" class="dept-color-input border rounded h-8 w-8 cursor-pointer p-0.5 bg-white" />
                     <button class="btn-delete-dept text-gray-400 hover:text-red-500 transition-colors">
                        <span class="material-symbols-outlined text-lg">delete</span>
                     </button>
                 `;
                deptList.appendChild(row);

                const nameInput = row.querySelector('.dept-name-input');
                const nickInput = row.querySelector('.dept-nickname-input');
                const delBtn = row.querySelector('.btn-delete-dept');

                // Auto-fill nickname logic
                nameInput.addEventListener('input', (e) => {
                    if (!nickInput.value) nickInput.value = e.target.value.substring(0, 2);
                });

                nickInput.addEventListener('input', (e) => {
                    let val = e.target.value;
                    if (val.length === 3 && !/[0-9]/.test(val)) e.target.value = val.substring(0, 2);
                });

                delBtn.onclick = () => row.remove();
            };

            // Ensure at least 10 slots
            let deptsToRender = genDepts.length > 0 ? [...genDepts] : [];
            const minCount = 10;
            while (deptsToRender.length < minCount) {
                deptsToRender.push({});
            }

            deptsToRender.forEach((d, i) => renderRow(d, i));

            // Bind Add Button
            const btnAdd = document.getElementById('btn-add-dept-slot');
            if (btnAdd) {
                btnAdd.onclick = () => {
                    renderRow({}, deptList.children.length);
                };
            }
        }

        // Special Departments (Same logic as before, just kept for completeness)
        const specList = document.getElementById('admin-special-dept-list');
        if (specList) {
            specList.innerHTML = '';
            const targetDepts = this.SPECIAL_DEPTS || [];
            const allDepts = this.state.departments || [];
            const defaultSpecColors = {
                'admin_office': '#64748b', 'vice_principal': '#71717a', 'principal': '#4b5563',
                'head_teacher': '#3b82f6', 'science_head': '#0ea5e9', 'advanced_teacher': '#8b5cf6'
            };

            targetDepts.forEach(s => {
                const savedRow = allDepts.find(d => d.dept_name === s.name);
                const defColor = defaultSpecColors[s.id] || '#9ca3af';
                const color = savedRow ? (savedRow.dept_color || defColor) : defColor;
                const active = savedRow ? savedRow.is_active : false;
                let nickname = savedRow ? (savedRow.dept_short || '') : '';
                if (!nickname) nickname = s.name.substring(0, 2);

                const div = document.createElement('div');
                div.className = "flex items-center gap-2 mb-2 special-dept-row";
                if (savedRow) div.dataset.id = savedRow.id;
                div.dataset.name = s.name;

                div.innerHTML = `
                     <input type="text" value="${s.name}" readonly class="bg-white text-gray-600 border rounded px-2 py-1 w-32 cursor-default focus:ring-0" />
                     <input type="text" value="${nickname}" class="special-dept-nickname border rounded px-2 py-1 w-16 text-center text-sm focus:ring-2 focus:ring-purple-200" placeholder="약어" maxlength="3" />
                     <input type="color" value="${color}" class="special-dept-color border rounded h-8 w-8 cursor-pointer p-0.5 bg-white" />
                     <label class="flex items-center gap-2 cursor-pointer text-sm select-none">
                         <input type="checkbox" class="special-dept-check rounded text-purple-600 focus:ring-purple-500" ${active ? 'checked' : ''}>
                         <span class="text-gray-600">사용</span>
                     </label>
                 `;
                specList.appendChild(div);

                const specNick = div.querySelector('.special-dept-nickname');
                specNick.addEventListener('input', (e) => {
                    let val = e.target.value;
                    if (val.length === 3 && !/[0-9]/.test(val)) e.target.value = val.substring(0, 2);
                });
            });
        }

        // --- 4. Basic Schedules (Fetch from new Table) ---
        const targetY = this.state.currentYear;
        const { data: scheduleRows } = await window.SupabaseClient.supabase
            .from('basic_schedules')
            .select('*')
            .eq('academic_year', targetY);

        const schedules = scheduleRows || [];

        if (schedules.length === 0) {
            alert(`${targetY}학년도 학사일정 데이터가 없습니다.\n"학년도 및 기본 학사 일정 저장 버튼"을 누르면, 새 학년도가 시작됩니다.`);
        }

        // Clear fields first
        const clearInputs = ['sched-sem1-start', 'sched-summer-start', 'sched-summer-start-ceremony', 'sched-summer-end',
            'sched-sem2-start', 'sched-winter-start-ceremony', 'sched-winter-start', 'sched-winter-end',
            'sched-spring-start-ceremony', 'sched-spring-vac-start', 'sched-spring-end', 'sched-spring-start', 'sched-spring-sem-start'];
        clearInputs.forEach(id => setVal(id, ''));

        this.currentFixedHolidays = {};
        this.currentVariableHolidays = [];
        this.currentMajorEvents = [];

        // Mapping Code -> DOM
        const codeMap = {
            'TERM1_START': 'sched-sem1-start',
            'SUMMER_VAC': { s: 'sched-summer-start', e: 'sched-summer-end' },
            'SUMMER_VAC_CEREMONY': 'sched-summer-start-ceremony',
            'TERM2_START': 'sched-sem2-start',
            'WINTER_VAC_CEREMONY': 'sched-winter-start-ceremony',
            'WINTER_VAC': { s: 'sched-winter-start', e: 'sched-winter-end' },
            'SPRING_VAC_CEREMONY': 'sched-spring-start-ceremony',
            'SPRING_VAC': { s: 'sched-spring-start', e: 'sched-spring-end' },
            'SPRING_SEM_START': 'sched-spring-sem-start'
        };

        // Parse Rows
        schedules.forEach(row => {
            // System Codes
            if (row.code) {
                if (row.type === 'exam') {
                    // Exams (EXAM_X_X)
                    const doms = {
                        'EXAM_1_1': { s: 'sched-exam-1-1-start', e: 'sched-exam-1-1-end' },
                        'EXAM_1_2': { s: 'sched-exam-1-2-start', e: 'sched-exam-1-2-end' },
                        'EXAM_2_1': { s: 'sched-exam-2-1-start', e: 'sched-exam-2-1-end' },
                        'EXAM_2_2': { s: 'sched-exam-2-2-start', e: 'sched-exam-2-2-end' },
                        'EXAM_3_2_2': { s: 'sched-exam-3-2-2-start', e: 'sched-exam-3-2-2-end' }
                    };
                    if (doms[row.code]) {
                        setVal(doms[row.code].s, row.start_date);
                        setVal(doms[row.code].e, row.end_date);
                        // Store ID for system codes as well in a hidden map if needed?
                        // Actually, we can just fetch all IDs for the year during Save.
                    }
                } else {
                    // Terms/Vac
                    const target = codeMap[row.code];
                    if (target) {
                        if (typeof target === 'string') {
                            setVal(target, row.start_date);
                        } else {
                            setVal(target.s, row.start_date);
                            setVal(target.e, row.end_date);
                        }
                    }
                }
            } else {
                // No Code -> Collections
                if (row.type === 'holiday') {
                    if (row.is_holiday) { // Fixed or Variable check effectively
                        // We treat all holidays from DB as "Variable" for editing purposes in UI unless we match fixed list logic?
                        // Actually, standard fixed holidays (3.1 etc) are calc'd. 
                        // If we find them in DB, we should separate them.
                        // But wait, the SAVE logic dumped calc'd holidays into DB too.
                        // So on LOAD, we should probably distinct them.
                        // Simple strategy: Just put everything in "Variable" container for now? 
                        // User wants to see "Fixed" separately usually.
                        // Let's rely on standard Calc for "Fixed" and filtered DB rows for "Variable" if possible?
                        // But we SAVED everything.
                        // Let's filter: if date matches result of 'calculateMergedHolidays', put in Fixed, else Variable.
                        const fixedRef = this.calculateMergedHolidays(targetY);
                        // We need simple check.
                        // Actually, let's just populate currentVariableHolidays.
                        // BUT, user sees Fixed List separately.
                        // Optimization: Filter out names that match standard fixed holidays for that date.
                    }
                }
            }
        });

        // Refine Holidays Loading
        // 1. Calculate Standard Fixed
        const standardFixed = this.calculateMergedHolidays(targetY);
        if (schedules.length > 0) {
            const dbFilteredFixed = {};
            Object.entries(standardFixed).forEach(([date, name]) => {
                const names = name.split(", ");
                const confirmedNames = names.filter(n =>
                    schedules.some(r => r.type === 'holiday' && r.start_date === date && r.name === n)
                );
                if (confirmedNames.length > 0) {
                    dbFilteredFixed[date] = confirmedNames.join(", ");
                }
            });
            this.currentFixedHolidays = dbFilteredFixed;
        } else {
            this.currentFixedHolidays = standardFixed;
        }
        this.renderFixedHolidays(this.currentFixedHolidays);

        // 2. Identify Variables (In DB but not in Standard)
        const variableRows = schedules.filter(r => r.type === 'holiday');
        const ayStart = `${targetY}-03-01`;
        const ayEnd = `${parseInt(targetY) + 1}-02-29`;

        variableRows.forEach(r => {
            // Range check: Only items belonging to THIS academic year calendar (Mar to Feb)
            if (r.start_date < ayStart || r.start_date > ayEnd) return;

            // Check if this date/name exists in standard
            const standardName = standardFixed[r.start_date];
            if (!standardName) {
                this.currentVariableHolidays.push({ id: r.id, date: r.start_date, name: r.name });
            }
        });
        this.currentVariableHolidays.sort((a, b) => a.date.localeCompare(b.date));
        this.renderVariableHolidays(this.currentVariableHolidays);

        // --- Auto-Fill Term 1 Start if Missing (Dynamic) ---
        // Using targetY + Holidays (Fixed+Variable) we just loaded/calc'd
        const t1Code = schedules.find(r => r.code === 'TERM1_START');
        if (!t1Code) {
            const y = parseInt(targetY);
            // Start search from March 1st (Local)
            let d = new Date(y, 2, 1); // March 1st

            let safety = 0;
            while (safety < 31) {
                // isSchoolDay uses this.currentFixedHolidays / this.currentVariableHolidays by default
                if (this.isSchoolDay(d)) break;
                d.setDate(d.getDate() + 1);
                safety++;
            }
            const t1Start = this.formatLocal(d);
            setVal('sched-sem1-start', t1Start);
        }

        // 3. Major Events (No Code, Type=event)
        // Filter out Ceremonies if they have codes (which they do)
        const majorRows = schedules.filter(r => r.type === 'event' && !r.code);
        majorRows.forEach(r => {
            if (r.start_date < ayStart || r.start_date > ayEnd) return;
            this.currentMajorEvents.push({ id: r.id, start: r.start_date, end: r.end_date, name: r.name });
        });
        this.currentMajorEvents.sort((a, b) => a.start.localeCompare(b.start));
        this.renderMajorEvents(this.currentMajorEvents);

        // 4. Env Events (Fixed)
        this.renderFixedEnvEvents();
    },

    renderFixedHolidays: function (holidays) {
        const container = document.getElementById('fixed-holidays-list');
        if (!container) return;
        container.innerHTML = '';

        const getSortWeight = (dateKey) => {
            const parts = dateKey.split('-');
            const mmdd = parts.length === 3 ? parts[1] + parts[2] : dateKey;
            const mm = parseInt(mmdd.substring(0, 2));
            const dd = parseInt(mmdd.substring(2, 4));
            const sortMm = (mm < 3) ? mm + 12 : mm;
            return sortMm * 100 + dd;
        };

        const sorted = Object.entries(holidays).sort((a, b) => getSortWeight(a[0]) - getSortWeight(b[0]));
        const dayNames = ['일', '월', '화', '수', '목', '금', '토'];

        sorted.forEach(([dateKey, name]) => {
            const div = document.createElement('div');
            // Fixed height h-[40px] to match inputs
            div.className = "flex items-center justify-between bg-white px-3 h-[40px] rounded border border-gray-100 shadow-sm mb-1 hover:bg-purple-50 transition-colors";

            let displayDate = dateKey;
            if (dateKey.length === 10) {
                const d = new Date(dateKey);
                displayDate = `${dateKey}(${dayNames[d.getDay()]})`;
            }

            const isSubstitute = name.includes('대체');
            div.innerHTML = `
                <span class="font-medium text-sm ${isSubstitute ? 'text-blue-600' : 'text-gray-700'}">${displayDate}</span>
                <span class="text-sm ${isSubstitute ? 'text-blue-500 font-medium' : 'text-gray-500'}">${name}</span>
            `;
            container.appendChild(div);
        });
    },

    /**
     * Calculates all holidays for the given academic year, including Lunar and Alternative holidays.
     */
    calculateMergedHolidays: function (academicYear) {
        const year = parseInt(academicYear);
        const baseHolidays = {
            "0301": "삼일절", "0501": "근로자의날", "0505": "어린이날",
            "0606": "현충일", "0717": "제헌절", "0815": "광복절", "1003": "개천절",
            "1009": "한글날", "1225": "성탄절", "0101": "신정"
        };
        const results = {}; // key: YYYY-MM-DD, value: name

        // 1. Add Base Fixed Holidays
        Object.entries(baseHolidays).forEach(([mmdd, name]) => {
            const mm = parseInt(mmdd.substring(0, 2));
            const y = (mm < 3) ? year + 1 : year;
            results[`${y}-${mmdd.substring(0, 2)}-${mmdd.substring(2, 4)}`] = name;
        });

        // 2. Add Lunar Holidays
        // Buddha's Birthday
        const solarBuddha = this.getSolarFromLunar(year, "0408");
        if (solarBuddha) results[solarBuddha] = (results[solarBuddha] ? results[solarBuddha] + ", " : "") + "부처님오신날";

        // Lunar New Year & Chuseok with Eve/After days
        const addLunarSpan = (lmmdd, mainName) => {
            // Academic year start is March. Lunar New Year (0101) always falls in Jan/Feb of the NEXT calendar year.
            const targetCalYear = (lmmdd === "0101") ? year + 1 : year;
            const mainSolar = this.getSolarFromLunar(targetCalYear, lmmdd);
            if (mainSolar) {
                const eve = this.adjustSolarDate(mainSolar, -1);
                const after = this.adjustSolarDate(mainSolar, 1);
                results[eve] = (results[eve] ? results[eve] + ", " : "") + `${mainName} 연휴`;
                results[mainSolar] = (results[mainSolar] ? results[mainSolar] + ", " : "") + mainName;
                results[after] = (results[after] ? results[after] + ", " : "") + `${mainName} 연휴`;
            }
        };
        addLunarSpan("0101", "설날");
        addLunarSpan("0815", "추석");

        // 3. Calculate Alternative Holidays (Substitute)
        // Rule: 
        // - 설날, 추석, 어린이날: 일요일 또는 다른 공휴일과 겹칠 경우 (단, 설날/추석은 토요일 겹침 무시)
        // - 국경일(3.1, 8.15, 10.3, 10.9), 성탄절, 부처님오신날: 토요일 또는 일요일과 겹칠 경우
        const isEligibleForSub = (name) => {
            if (["삼일절", "광복절", "개천절", "한글날", "성탄절", "부처님오신날"].includes(name)) return "weekend";
            if (["어린이날"].includes(name)) return "all"; // Sat, Sun, or other holiday
            if (["설날", "설날 연휴", "추석", "추석 연휴"].includes(name)) return "sunday";
            return null;
        };

        const sortedDays = Object.keys(results).sort();
        const substitutes = {};

        sortedDays.forEach(dateStr => {
            const names = results[dateStr].split(", ");
            names.forEach(name => {
                const type = isEligibleForSub(name);
                if (!type) return;

                const d = this.parseLocal(dateStr);
                const dayNum = d.getDay(); // 0:Sun, 6:Sat
                let needsSub = false;

                if (type === "weekend" && (dayNum === 0 || dayNum === 6)) needsSub = true;
                else if (type === "sunday" && dayNum === 0) needsSub = true;
                else if (type === "all") {
                    // Weekend OR Overlap with another holiday (names.length > 1)
                    if (dayNum === 0 || dayNum === 6 || names.length > 1) needsSub = true;
                }

                if (needsSub) {
                    let subDate = this.adjustSolarDate(dateStr, 1);
                    while (true) {
                        const sd = this.parseLocal(subDate);
                        const sNum = sd.getDay();
                        // Next non-weekend and non-existing holiday
                        if (sNum !== 0 && sNum !== 6 && !results[subDate] && !substitutes[subDate]) {
                            substitutes[subDate] = `대체공휴일(${name})`;
                            break;
                        }
                        subDate = this.adjustSolarDate(subDate, 1);
                    }
                }
            });
        });

        return { ...results, ...substitutes };
    },

    adjustSolarDate: (solarStr, days) => {
        const d = new Date(solarStr);
        d.setDate(d.getDate() + days);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },

    renderVariableHolidays: function (list) {
        const container = document.getElementById('variable-holidays-container');
        if (!container) return;
        container.innerHTML = '';
        const dayNames = ['일', '월', '화', '수', '목', '금', '토'];

        list.forEach((item, idx) => {
            const div = document.createElement('div');
            if (item.id) div.dataset.id = item.id; // Store DB ID
            const isEditing = !item.date || !item.name || item.isEditing;

            if (isEditing) {
                // Remove bg-white, border, shadow when editing as requested
                div.className = "flex items-center justify-between px-1 mb-1 group transition-all";
                div.innerHTML = `
                    <div class="flex items-center gap-2 w-full overflow-hidden">
                        <input type="date" value="${item.date || ''}" max="2099-12-31"
                            class="holiday-date border rounded-lg px-3 py-2 text-sm w-[150px] focus:ring-2 focus:ring-purple-200 transition-colors" />
                        <input type="text" value="${item.name || ''}" placeholder="명칭" 
                            class="holiday-name flex-grow border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-purple-200 min-w-0 transition-colors" />
                        <button type="button" class="btn-del-hol text-red-300 hover:text-red-500 flex items-center shrink-0 ml-1">
                            <span class="material-symbols-outlined text-xl">delete</span>
                        </button>
                    </div>
                `;
            } else {
                // View mode: keep the "box" look to match fixed holidays
                div.className = "flex items-center justify-between bg-white px-3 h-[40px] rounded border border-gray-100 shadow-sm mb-1 group hover:bg-purple-50 transition-all cursor-pointer";

                let displayDate = item.date;
                try {
                    const d = new Date(item.date);
                    if (!isNaN(d.getTime())) displayDate = `${item.date}(${dayNames[d.getDay()]})`;
                } catch (e) { }

                div.innerHTML = `
                    <span class="font-medium text-sm text-gray-700">${displayDate}</span>
                    <div class="flex items-center gap-2">
                        <span class="text-sm text-gray-500">${item.name}</span>
                        <button type="button" class="btn-edit-hol opacity-0 group-hover:opacity-100 text-gray-400 hover:text-blue-500 transition-opacity mr-1">
                            <span class="material-symbols-outlined text-lg">edit</span>
                        </button>
                        <button type="button" class="btn-del-hol opacity-0 group-hover:opacity-100 text-red-300 hover:text-red-500 transition-opacity">
                            <span class="material-symbols-outlined text-lg">delete</span>
                        </button>
                    </div>
                `;

                div.onclick = (e) => {
                    if (e.target.closest('.btn-del-hol')) return;
                    this.syncVariableHolidaysFromUI();
                    this.currentVariableHolidays[idx].isEditing = true;
                    this.renderVariableHolidays(this.currentVariableHolidays);
                };
            }

            container.appendChild(div);

            const delBtn = div.querySelector('.btn-del-hol');
            if (delBtn) {
                delBtn.onclick = (e) => {
                    e.stopPropagation();
                    this.syncVariableHolidaysFromUI();
                    this.currentVariableHolidays.splice(idx, 1);
                    this.renderVariableHolidays(this.currentVariableHolidays);
                };
            }
        });
    },

    syncVariableHolidaysFromUI: function () {
        const container = document.getElementById('variable-holidays-container');
        if (!container) return;

        const newList = [];
        Array.from(container.children).forEach((div, i) => {
            const dateInput = div.querySelector('.holiday-date');
            const nameInput = div.querySelector('.holiday-name');

            if (dateInput && nameInput) {
                newList.push({
                    id: div.dataset.id || undefined, // Use undefined for omission
                    date: dateInput.value,
                    name: nameInput.value,
                    isEditing: true
                });
            } else {
                if (this.currentVariableHolidays && this.currentVariableHolidays[i]) {
                    newList.push(this.currentVariableHolidays[i]);
                }
            }
        });
        this.currentVariableHolidays = newList;
    },

    renderMajorEvents: function (list) {
        const container = document.getElementById('major-events-container');
        if (!container) return;
        container.innerHTML = '';

        const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
        const getDisplayDate = (dateStr) => {
            if (!dateStr) return '';
            try {
                const d = new Date(dateStr);
                if (!isNaN(d.getTime())) return `${dateStr}(${dayNames[d.getDay()]})`;
            } catch (e) { }
            return dateStr;
        };

        list.forEach((item, idx) => {
            const div = document.createElement('div');
            if (item.id) div.dataset.id = item.id; // Store DB ID
            const isEditing = !item.start || !item.name || item.isEditing;

            if (isEditing) {
                div.className = "flex items-center gap-1 w-full p-1 mb-1 bg-gray-50";
                div.innerHTML = `
                    <div class="flex items-center gap-2 w-full">
                         <div class="flex items-center gap-1">
                            <input type="date" value="${item.start || ''}" max="2099-12-31"
                                class="event-start border rounded-lg px-3 py-2 text-sm w-[140px] focus:ring-2 focus:ring-blue-200 transition-colors" />
                            <span class="text-gray-400 text-sm">~</span>
                            <input type="date" value="${item.end || ''}" max="2099-12-31"
                                class="event-end border rounded-lg px-3 py-2 text-sm w-[140px] focus:ring-2 focus:ring-blue-200 transition-colors" />
                         </div>
                    
                        <input type="text" value="${item.name || ''}" placeholder="행사명" 
                            class="event-name flex-grow border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-200 min-w-0 transition-colors" />
                        
                        <button type="button" class="btn-del-major text-red-400 hover:text-red-600 shrink-0 ml-1">
                            <span class="material-symbols-outlined text-xl">delete</span>
                        </button>
                    </div>
                `;
            } else {
                div.className = "flex items-center justify-between bg-white px-3 h-[40px] rounded border border-gray-100 shadow-sm mb-1 group hover:bg-blue-50 transition-all cursor-pointer";

                let dateStr = getDisplayDate(item.start);
                if (item.end && item.end !== item.start) {
                    dateStr += ` ~ ${getDisplayDate(item.end)}`;
                }

                div.innerHTML = `
                    <span class="font-medium text-sm text-gray-700">${dateStr}</span>
                    <div class="flex items-center gap-2">
                        <span class="text-sm text-gray-500">${item.name}</span>
                        <button type="button" class="btn-edit-major opacity-0 group-hover:opacity-100 text-gray-400 hover:text-blue-500 transition-opacity mr-1">
                            <span class="material-symbols-outlined text-lg">edit</span>
                        </button>
                        <button type="button" class="btn-del-major opacity-0 group-hover:opacity-100 text-red-300 hover:text-red-500 transition-opacity">
                            <span class="material-symbols-outlined text-lg">delete</span>
                        </button>
                    </div>
                `;

                div.onclick = (e) => {
                    if (e.target.closest('.btn-del-major')) return;
                    this.syncMajorEventsFromUI();
                    this.currentMajorEvents[idx].isEditing = true;
                    this.renderMajorEvents(this.currentMajorEvents);
                };
            }

            container.appendChild(div);

            const delBtn = div.querySelector('.btn-del-major');
            if (delBtn) {
                delBtn.onclick = (e) => {
                    e.stopPropagation();
                    this.syncMajorEventsFromUI();
                    this.currentMajorEvents.splice(idx, 1);
                    this.renderMajorEvents(this.currentMajorEvents);
                };
            }
        });
    },

    renderFixedEnvEvents: function () {
        const container = document.getElementById('fixed-env-events-list');
        if (!container || !this.FIXED_ENV_EVENTS) return;
        container.innerHTML = '';

        const year = this.state.currentYear || new Date().getFullYear();
        const dayNames = ['일', '월', '화', '수', '목', '금', '토'];

        // Sort by date MMDD
        const sorted = Object.entries(this.FIXED_ENV_EVENTS).sort((a, b) => a[0].localeCompare(b[0]));

        sorted.forEach(([dateKey, name]) => {
            const div = document.createElement('div');
            div.className = "flex items-center justify-between bg-white px-3 h-[40px] rounded border border-gray-100 shadow-sm mb-1 hover:bg-green-50 transition-colors";

            const fullDate = `${year}-${dateKey}`;
            let displayDate = fullDate;
            try {
                const d = new Date(fullDate);
                if (!isNaN(d.getTime())) {
                    displayDate = `${fullDate}(${dayNames[d.getDay()]})`;
                }
            } catch (e) { }

            div.innerHTML = `
                <span class="font-medium text-sm text-gray-700">${displayDate}</span>
                <span class="text-sm text-green-600 font-medium">${name}</span>
            `;
            container.appendChild(div);
        });
    },

    syncMajorEventsFromUI: function () {
        const container = document.getElementById('major-events-container');
        if (!container) return;

        const newList = [];
        Array.from(container.children).forEach((div, i) => {
            const nameInput = div.querySelector('.event-name');
            const startInput = div.querySelector('.event-start');
            const endInput = div.querySelector('.event-end');

            if (nameInput && startInput) {
                newList.push({
                    id: div.dataset.id || undefined, // Use undefined for omission
                    start: startInput.value,
                    end: (endInput && endInput.value) ? endInput.value : '',
                    name: nameInput.value,
                    isEditing: true
                });
            } else {
                if (this.currentMajorEvents && this.currentMajorEvents[i]) {
                    newList.push(this.currentMajorEvents[i]);
                }
            }
        });
        this.currentMajorEvents = newList;
    },

    getSolarFromLunar: function (targetYear, mmdd) {
        if (!window.KoreanLunarCalendar || !mmdd || mmdd.length !== 4) return null;
        try {
            const mm = parseInt(mmdd.substring(0, 2));
            const dd = parseInt(mmdd.substring(2, 4));
            const y = parseInt(targetYear);

            const converter = new window.KoreanLunarCalendar();
            converter.setLunarDate(y, mm, dd, false);
            const solar = converter.getSolarCalendar();

            if (!solar.year || !solar.month || !solar.day) return null;

            return `${solar.year}-${String(solar.month).padStart(2, '0')}-${String(solar.day).padStart(2, '0')}`;
        } catch (e) {
            return null;
        }
    },

    handleSaveSchoolInfo: async function () {
        const { data: { session } } = await window.SupabaseClient.supabase.auth.getSession();
        if (!session || this.state.role !== 'admin') {
            alert('세션이 만료되었거나 관리자 권한이 없습니다. 다시 로그인해 주세요.');
            if (!session) this.navigate('login');
            return;
        }

        const getVal = (id) => document.getElementById(id)?.value || '';

        const schoolNameKR = getVal('setting-school-name-kr').trim();
        const schoolNameEN = getVal('setting-school-name-en').trim();
        const schoolLevelKR = getVal('setting-school-level-kr');
        const schoolLevelEN = getVal('setting-school-level-en');

        if (!schoolNameKR && !schoolNameEN) {
            alert('학교명(한글 또는 영문)을 입력해 주세요.');
            return;
        }

        // Validation: If Korean name exists, level must be selected
        if (schoolNameKR && !schoolLevelKR) {
            alert('학교급(초등학교/중학교/고등학교 등)을 꼭 선택해 주세요.');
            return;
        }

        // 1. Construct full_name_kr (e.g. "포곡" + "고등학교" = "포곡고등학교")
        const fullNameKR = schoolNameKR ? (schoolNameKR + schoolLevelKR) : '';

        // Continue with display name for 'school_name' field
        // USER REQUEST: school_name should store the "PURE" name.
        const pureName = schoolNameKR;

        let displayName = schoolNameKR;
        if (schoolNameKR && schoolNameEN) {
            displayName = `${schoolNameKR} (${schoolNameEN})`;
        } else if (!schoolNameKR && schoolNameEN) {
            displayName = schoolNameEN;
        }

        const academicYear = parseInt(document.getElementById('setting-academic-year').value);

        const { data: existing } = await window.SupabaseClient.supabase
            .from('settings')
            .select('id')
            .eq('academic_year', academicYear)
            .maybeSingle();

        const payload = {
            academic_year: academicYear,
            school_name: pureName, // Store pure name as requested
            full_name_kr: fullNameKR, // Store concatenated version for display
            name_en: schoolNameEN,
            level_kr: schoolLevelKR,
            level_en: schoolLevelEN
        };

        if (existing) payload.id = existing.id;

        const { error } = await window.SupabaseClient.supabase
            .from('settings')
            .upsert(payload);

        if (error) {
            alert('학교 정보 저장 실패: ' + error.message);
        } else {
            alert('학교 정보가 성공적으로 저장되었습니다.');
            location.reload();
        }
    },

    handleSaveSettings: async function () {
        const btnSave = document.getElementById('btn-save-settings');
        const originalBtnText = btnSave ? btnSave.innerHTML : '저장';

        if (btnSave) {
            btnSave.disabled = true;
            btnSave.innerHTML = '<span class="material-symbols-outlined animate-spin">sync</span> 저장 중...';
        }

        try {
            const { data: { session } } = await window.SupabaseClient.supabase.auth.getSession();
            if (!session || this.state.role !== 'admin') {
                throw new Error('세션이 만료되었거나 관리자 권한이 없습니다.');
            }

            // Collect Data
            const yearVal = document.getElementById('setting-academic-year').value;
            const academicYear = parseInt(yearVal);
            if (isNaN(academicYear)) {
                throw new Error('올바른 학년도를 선택해 주세요.');
            }

            const getVal = (id) => {
                const val = document.getElementById(id)?.value;
                return val || '';
            };

            // Variable Holidays Array -> Object
            this.syncVariableHolidaysFromUI();
            const variableHolidays = {};
            if (this.currentVariableHolidays) {
                this.currentVariableHolidays.forEach(h => {
                    if (h.date && h.name) {
                        variableHolidays[h.date] = h.name;
                    }
                });
            }

            // Major Events: Consolidate User Events + Exams into Array
            this.syncMajorEventsFromUI();

            const finalMajorEvents = [];

            // 1. User Events
            if (this.currentMajorEvents) {
                this.currentMajorEvents.forEach(e => {
                    if (e.start && e.name) {
                        finalMajorEvents.push({
                            type: 'event',
                            start: e.start,
                            end: e.end || e.start,
                            name: e.name
                        });
                    }
                });
            }

            // 2. Exams Input
            const examDefinitions = [
                { code: 'EXAM_1_1', title: '1학기 1차지필', s: 'sched-exam-1-1-start', e: 'sched-exam-1-1-end' },
                { code: 'EXAM_1_2', title: '1학기 2차지필', s: 'sched-exam-1-2-start', e: 'sched-exam-1-2-end' },
                { code: 'EXAM_2_1', title: '2학기 1차지필', s: 'sched-exam-2-1-start', e: 'sched-exam-2-1-end' },
                { code: 'EXAM_2_2', title: '2학기 2차지필', s: 'sched-exam-2-2-start', e: 'sched-exam-2-2-end' },
                { code: 'EXAM_3_2_2', title: '3학년 2학기 2차지필', s: 'sched-exam-3-2-2-start', e: 'sched-exam-3-2-2-end' }
            ];

            examDefinitions.forEach(def => {
                const sVal = getVal(def.s);
                const eVal = getVal(def.e);
                if (sVal && eVal) {
                    finalMajorEvents.push({
                        type: 'exam',
                        code: def.code,
                        title: def.title,
                        start: sVal,
                        end: eVal
                    });
                }
            });

            // Department Config Collection
            const generalDepts = [];
            document.querySelectorAll('#admin-dept-list .dept-row').forEach(row => {
                const id = row.dataset.id;
                const nameInp = row.querySelector('.dept-name-input');
                const name = nameInp ? nameInp.value.trim() : '';
                const nickInp = row.querySelector('.dept-nickname-input');
                const nickname = nickInp ? nickInp.value.trim() : '';
                const color = row.querySelector('.dept-color-input').value;
                if (name) {
                    generalDepts.push({ id, name, nickname, color });
                }
            });


            // Prepare DB Payload (School Info ONLY)
            const schoolNameKR = getVal('setting-school-name-kr').trim();
            const schoolNameEN = getVal('setting-school-name-en').trim();

            let displayName = schoolNameKR;
            if (schoolNameKR && schoolNameEN) {
                displayName = `${schoolNameKR} (${schoolNameEN})`;
            } else if (!schoolNameKR && schoolNameEN) {
                displayName = schoolNameEN;
            }

            const { data: existing } = await window.SupabaseClient.supabase
                .from('settings')
                .select('id')
                .eq('academic_year', academicYear)
                .maybeSingle();

            const settingsPayload = {
                academic_year: academicYear,
                school_name: schoolNameKR, // FIX: Store pure name only to prevent "Name (EN) (EN)" loop
                full_name_kr: schoolNameKR ? (schoolNameKR + getVal('setting-school-level-kr')) : null,
                name_en: schoolNameEN || null,
                level_kr: getVal('setting-school-level-kr'),
                level_en: getVal('setting-school-level-en')
            };

            if (existing) settingsPayload.id = existing.id;

            // Safety: Ensure id is not null/undefined/string "null"
            if (!settingsPayload.id || settingsPayload.id === 'null' || settingsPayload.id === 'undefined') {
                delete settingsPayload.id;
            }

            const { error: settingsError } = await window.SupabaseClient.supabase
                .from('settings')
                .upsert(settingsPayload);

            if (settingsError) throw settingsError;

            // --- Basic Schedules Migration ---

            // 1. Get ALL records for this year in DB FIRST for robust ID matching
            const { data: dbBasics } = await window.SupabaseClient.supabase
                .from('basic_schedules')
                .select('*')
                .eq('academic_year', academicYear);

            const dbBasicsList = dbBasics || [];

            // Helper to match existing records
            const findExistingId = (type, code, name, start) => {
                if (code) {
                    const found = dbBasicsList.find(r => r.code === code);
                    if (found) return found.id;
                }
                const found = dbBasicsList.find(r => r.type === type && r.name === name && r.start_date === start);
                return found ? found.id : undefined;
            };

            const basicRows = [];
            const addRow = (type, code, name, start, end = null, is_holiday = false) => {
                if (!start) return;
                const row = {
                    academic_year: academicYear,
                    type,
                    code,
                    name,
                    start_date: start,
                    end_date: end || start,
                    is_holiday
                };
                const existingId = findExistingId(type, code, name, start);
                if (existingId && existingId !== 'null' && existingId !== 'undefined') {
                    row.id = existingId;
                }
                basicRows.push(row);
            };

            // A. Flatten all data to rows
            // 1. Terms & Vacations
            addRow('term', 'TERM1_START', '1학기 개학', getVal('sched-sem1-start'));
            addRow('vacation', 'SUMMER_VAC', '여름방학', getVal('sched-summer-start'), getVal('sched-summer-end'));
            addRow('event', 'SUMMER_VAC_CEREMONY', '여름방학식', getVal('sched-summer-start-ceremony'));
            addRow('term', 'TERM2_START', '2학기 개학', getVal('sched-sem2-start'));
            addRow('event', 'WINTER_VAC_CEREMONY', '겨울방학식', getVal('sched-winter-start-ceremony'));
            addRow('vacation', 'WINTER_VAC', '겨울방학', getVal('sched-winter-start'), getVal('sched-winter-end'));
            addRow('event', 'SPRING_VAC_CEREMONY', '봄방학식', getVal('sched-spring-start-ceremony'));
            addRow('vacation', 'SPRING_VAC', '봄방학', getVal('sched-spring-start'), getVal('sched-spring-end'));
            addRow('term', 'SPRING_SEM_START', '봄 개학', getVal('sched-spring-sem-start'));

            // 2. Fixed Holidays
            if (this.currentFixedHolidays) {
                Object.entries(this.currentFixedHolidays).forEach(([date, name]) => {
                    addRow('holiday', null, name, date, null, true);
                });
            }

            // 3. Variable Holidays
            if (variableHolidays) {
                Object.entries(variableHolidays).forEach(([date, name]) => {
                    addRow('holiday', null, name, date, null, true);
                });
            }

            // 4. Exams
            examDefinitions.forEach(def => {
                const s = getVal(def.s);
                const e = getVal(def.e);
                if (s && e) addRow('exam', def.code, def.title, s, e);
            });

            // 5. Major Events
            finalMajorEvents.forEach(ev => {
                if (ev.type !== 'exam') addRow('event', null, ev.name, ev.start, ev.end);
            });

            // B. Identify Deletions
            const dbBasicIds = dbBasicsList.map(r => r.id);
            const payloadBasicIds = basicRows.filter(r => r.id).map(r => r.id);
            const toDeleteBasics = dbBasicIds.filter(id => !payloadBasicIds.includes(id));

            if (toDeleteBasics.length > 0) {
                const { error: delErr } = await window.SupabaseClient.supabase
                    .from('basic_schedules')
                    .delete()
                    .in('id', toDeleteBasics);
                if (delErr) throw delErr;
            }

            // C. Execute (Strict Separation to avoid NULL PK issues)
            const toUpdateBasic = [];
            const toInsertBasic = [];

            basicRows.forEach(row => {
                const clean = { ...row };
                if (clean.id && clean.id !== 'null' && clean.id !== 'undefined') {
                    toUpdateBasic.push(clean);
                } else {
                    delete clean.id; // Safety
                    toInsertBasic.push(clean);
                }
            });

            if (toUpdateBasic.length > 0) {
                const { error: updErr } = await window.SupabaseClient.supabase
                    .from('basic_schedules')
                    .upsert(toUpdateBasic);
                if (updErr) throw updErr;
            }

            if (toInsertBasic.length > 0) {
                const { error: insErr } = await window.SupabaseClient.supabase
                    .from('basic_schedules')
                    .insert(toInsertBasic);
                if (insErr) throw insErr;
            }

            // Sync Departments (Upsert New/Existing -> Delete Removed)
            // 1. Get existing IDs in DB for this year
            const { data: dbDepts } = await window.SupabaseClient.supabase
                .from('departments')
                .select('id')
                .eq('academic_year', academicYear);

            const dbIds = (dbDepts || []).map(d => d.id);

            const deptPayload = [];

            // 1. General
            generalDepts.forEach((d, i) => {
                const payload = {
                    academic_year: academicYear,
                    dept_name: d.name,
                    dept_short: d.nickname,
                    dept_color: d.color,
                    sort_order: i,
                    is_active: true
                };
                if (d.id) payload.id = d.id; // Keep existing ID
                deptPayload.push(payload);
            });

            // 2. Special
            document.querySelectorAll('.special-dept-row').forEach((row, i) => {
                const id = row.dataset.id; // DB UUID or empty
                const name = row.dataset.name; // e.g. "행정실"
                const nickname = row.querySelector('.special-dept-nickname').value;
                const color = row.querySelector('.special-dept-color').value;
                const active = row.querySelector('.special-dept-check').checked;

                const payload = {
                    academic_year: academicYear,
                    dept_name: name,
                    dept_short: nickname,
                    dept_color: color,
                    sort_order: 100 + i,
                    is_active: active
                };
                if (id) payload.id = id;
                deptPayload.push(payload);
            });

            // 3. Deletions: IDs in DB but NOT in current payload
            const payloadIds = deptPayload.filter(p => p.id).map(p => p.id);
            const toDelete = dbIds.filter(id => !payloadIds.includes(id));

            if (toDelete.length > 0) {
                await window.SupabaseClient.supabase
                    .from('departments')
                    .delete()
                    .in('id', toDelete);
            }

            if (deptPayload.length > 0) {
                const sanitizedDepts = deptPayload.map(d => {
                    const clean = { ...d };
                    if (!clean.id || clean.id === 'null' || clean.id === 'undefined') {
                        delete clean.id;
                    }
                    return clean;
                });

                if (sanitizedDepts.length > 0) {
                    const { error: deptError } = await window.SupabaseClient.supabase
                        .from('departments')
                        .upsert(sanitizedDepts);

                    if (deptError) throw deptError;
                }
            }

            // --- REPAIR LOGIC: Re-link orphaned schedules ---
            await this.repairOrphanedSchedules(academicYear);

            alert('학교 정보가 성공적으로 저장되었습니다.');
            // Reload the view with the currently selected year (don't force reload page)
            if (this.refreshAdminView) {
                await this.refreshAdminView(academicYear);
            } else {
                location.reload(); // Fallback
            }

            if (btnSave) {
                btnSave.disabled = false;
                btnSave.innerHTML = originalBtnText;
            }

        } catch (err) {
            console.error(err);
            alert('저장 실패: ' + (err.message || '알 수 없는 오류'));

            if (btnSave) {
                btnSave.disabled = false;
                btnSave.innerHTML = originalBtnText;
            }
        }

    },

    repairOrphanedSchedules: async function (currentAcademicYear) {
        console.log('Running Schedule Repair...');
        try {
            // 1. Find Orphaned Schedules (dept_id IS NULL AND dept_name IS NOT NULL)
            const { data: orphans, error } = await window.SupabaseClient.supabase
                .from('schedules')
                .select('id, dept_name, start_date')
                .is('dept_id', null)
                .neq('dept_name', null)
                .neq('dept_name', ''); // Ensure valid name

            if (error) throw error;
            if (!orphans || orphans.length === 0) return;

            console.log(`Found ${orphans.length} orphaned schedules. Attempting repair...`);

            // 2. Group Orphans by Calculated Academic Year to minimize Dept queries
            // Map: { "2025": [schedule, schedule...], "2026": [...] }
            const groupedByYear = {};

            orphans.forEach(sch => {
                if (!sch.start_date) return;
                const d = new Date(sch.start_date);
                const mm = d.getMonth() + 1;
                const y = d.getFullYear();
                // Academic Year Logic: Jan/Feb belongs to PREVIOUS year
                const ay = (mm < 3) ? y - 1 : y;

                if (!groupedByYear[ay]) groupedByYear[ay] = [];
                groupedByYear[ay].push(sch);
            });

            // 3. Process each Year Group
            for (const ayStr of Object.keys(groupedByYear)) {
                const ay = parseInt(ayStr);
                const yearOrphans = groupedByYear[ay];

                // Fetch Departments for this Academic Year
                const { data: depts } = await window.SupabaseClient.supabase
                    .from('departments')
                    .select('id, dept_name')
                    .eq('academic_year', ay);

                if (!depts || depts.length === 0) continue;

                // Create Name -> ID Map for this year
                const deptMap = {};
                depts.forEach(d => {
                    const normName = (d.dept_name || '').trim();
                    deptMap[normName] = d.id;
                });

                // 4. Prepare Updates
                const updates = [];
                yearOrphans.forEach(sch => {
                    const schName = (sch.dept_name || '').trim();
                    const foundId = deptMap[schName];

                    if (foundId) {
                        // Restore ID
                        updates.push({
                            id: sch.id,
                            dept_id: foundId
                        });
                    }
                });

                // 5. Execute Batch Update
                if (updates.length > 0) {
                    const { error: updErr } = await window.SupabaseClient.supabase
                        .from('schedules')
                        .upsert(updates);

                    if (updErr) console.error(`Repair failed for year ${ay}:`, updErr);
                    else console.log(`Repaired ${updates.length} schedules for year ${ay}`);
                }
            }
        } catch (e) {
            console.error('Schedule Repair Error:', e);
        }
    },

    updateBrand: function (schoolNameKR, schoolNameEN) {
        let display = 'GOELink';
        if (schoolNameKR || schoolNameEN) {
            if (schoolNameKR && schoolNameEN) {
                display = `${schoolNameKR} (${schoolNameEN})`;
            } else {
                display = schoolNameKR || schoolNameEN;
            }
        }

        const brandLabel = document.querySelector('h1.text-xl');
        if (brandLabel) {
            brandLabel.innerHTML = `${display} <span class="text-xs font-normal text-gray-500 ml-1">v2.0</span>`;
        }
    },


    // --- End of Schedules Management ---



    loadAdminUsers: async function () {
        const listContainer = document.getElementById('admin-user-list');
        if (!listContainer) return;

        try {
            const { data: users, error } = await window.SupabaseClient.supabase
                .from('user_roles')
                .select('*')
                .order('last_login', { ascending: false });

            if (error) throw error;

            if (users && users.length > 0) {
                listContainer.innerHTML = users.map(u => `
                    <div class="flex items-center justify-between p-2 border rounded hover:bg-gray-50">
                        <div>
                            <div class="font-bold text-sm text-gray-800">${u.email.split('@')[0]}</div>
                            <div class="text-xs text-gray-500">최근 접속: ${new Date(u.last_login).toLocaleDateString()}</div>
                        </div>
                        <div class="flex items-center gap-2">
                            <select onchange="window.App.updateUserRole('${u.user_id}', this.value)" class="text-xs border rounded p-1 ${u.role === 'admin' ? 'bg-purple-100 text-purple-700' : (u.role === 'head' ? 'bg-blue-100 text-blue-700' : 'bg-white')}">
                                <option value="teacher" ${u.role === "teacher" ? "selected" : ""}>일반 (Teacher)</option>
                                <option value="head" ${u.role === "head" ? "selected" : ""}>부장 (Head)</option>
                                <option value="admin" ${u.role === "admin" ? "selected" : ""}>관리자 (Admin)</option>
                            </select>
                            <select onchange="window.App.updateUserStatus('${u.user_id}', this.value)" class="text-xs border rounded p-1 ${u.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100'}">
                                <option value="pending" ${u.status === "pending" ? "selected" : ""}>대기</option>
                                <option value="active" ${u.status === "active" ? "selected" : ""}>승인</option>
                                <option value="rejected" ${u.status === "rejected" ? "selected" : ""}>거부</option>
                            </select>
                        </div>
                    </div>
                `).join('');
            } else {
                listContainer.innerHTML = "<p class='text-gray-400 text-center py-4'>사용자가 없습니다.</p>";
            }
        } catch (e) {
            console.error("Load Users Failed:", e);
            listContainer.innerHTML = "<p class='text-red-500 text-center py-4'>데이터 로딩 실패</p>";
        }
    },

    updateUserRole: async function (userId, newRole) {
        if (!confirm("권한을 변경하시겠습니까?")) {
            this.loadAdminUsers(); // Revert UI
            return;
        }

        const { error } = await window.SupabaseClient.supabase
            .from('user_roles')
            .update({ role: newRole })
            .eq('user_id', userId);

        if (error) {
            alert("업데이트 실패: " + error.message);
        } else {
            this.loadAdminUsers(); // Refresh
            this.logAction('UPDATE_ROLE', 'user_roles', userId, { newRole });
        }
    },

    updateUserStatus: async function (userId, newStatus) {
        const { error } = await window.SupabaseClient.supabase
            .from('user_roles')
            .update({ status: newStatus })
            .eq('user_id', userId);

        this.logAction('UPDATE_STATUS', 'user_roles', userId, { newStatus });
    },

    loadAuditLogs: async function () {
        const auditList = document.getElementById('admin-audit-list');
        if (auditList) {
            try {
                const { data: logs, error } = await window.SupabaseClient.supabase
                    .from('audit_logs')
                    .select('*')
                    .order('timestamp', { ascending: false })
                    .limit(20);

                if (error) throw error;

                if (logs && logs.length > 0) {
                    auditList.innerHTML = logs.map(log => `
                        <div class="border-b last:border-0 pb-2 mb-2">
                            <div class="flex justify-between items-center mb-1">
                                <span class="font-bold text-gray-800 text-xs px-2 py-0.5 rounded bg-gray-100">${log.action_type}</span>
                                <span class="text-xs text-gray-400">${new Date(log.timestamp).toLocaleString()}</span>
                            </div>
                            <div class="text-gray-600 truncate">${log.details ? JSON.stringify(JSON.parse(log.details)) : '-'}</div>
                        </div>
                    `).join('');
                } else {
                    auditList.innerHTML = "<p class='text-gray-400 text-center py-4'>기록된 로그가 없습니다.</p>";
                }
            } catch (e) {
                console.error("Failed to fetch audit logs:", e);
                auditList.innerHTML = "<p class='text-red-400 text-center py-4'>로그 로딩 실패</p>";
            }
        }
    },

    initCalendar: async function () {
        const calendarEl = document.getElementById('calendar');
        if (!calendarEl) return;

        // 1. Initialize State Container
        this.state.calendarData = {
            holidayMap: {},
            redDayMap: {},
            scheduleMap: {},
            backgroundEvents: [],
            departments: []
        };

        // 2. Setup FullCalendar
        const calendar = new FullCalendar.Calendar(calendarEl, {
            initialView: 'extendedMonth',
            initialDate: this.state.initialDate || undefined, // [SYNC] Use synchronized date
            locale: 'ko',
            buttonText: {
                today: '오늘',
                month: '월',
                extendedMonth: '월',
                list: '목록'
            },
            customButtons: {
                 // We don't use FC list view, so we override the button behavior or use custom Toolbar
                 // But simply, we can use the 'listWeek' button to trigger our view if we want, 
                 // OR we just add a custom button.
                 // Actually, FC header toolbar buttons for views switch FC views.
                 // To switch to OUR 'list' view, we should probably add a custom button or 
                 // rely on the top-level navigation if we had one.
                 // Current UI has 'extendedMonth,listWeek' in right header.
                 // Let's hijack 'listWeek' button click? No, FC handles it.
                customPrev: {
                    icon: 'chevron-left',
                    click: () => {
                        const current = this.state.calendar.getDate();
                        const target = new Date(current.getFullYear(), current.getMonth() - 1, 1);
                        this.state.calendar.gotoDate(target);
                    }
                },
                customNext: {
                    icon: 'chevron-right',
                    click: () => {
                        const current = this.state.calendar.getDate();
                        const target = new Date(current.getFullYear(), current.getMonth() + 1, 1);
                        this.state.calendar.gotoDate(target);
                    }
                },
                customDept: {
                    text: '부서별',
                    click: () => {
                        this.navigate('dept_list');
                    }
                },
                customList: {
                    text: '주간',
                    click: () => {
                        this.navigate('list');
                    }
                 }
            },
            headerToolbar: {
                left: 'customPrev,customNext today',
                center: 'title',
                right: 'extendedMonth,customDept,customList' // Use our custom buttons
            },
            height: '100%', // Fill container for interior scroll on screen
            expandRows: true, // Stretch rows to fill available space (memo space)
            dayMaxEvents: false,
            weekends: false,
            firstDay: 1, // Start on Monday
            fixedWeekCount: false,
            views: {
                extendedMonth: {
                    type: 'dayGrid',
                    dateIncrement: { months: 1 },
                    // titleFormat: { year: 'numeric', month: 'long' }, // Removed to rely on JS override
                    visibleRange: function (currentDate) {
                        const firstDay = 1; // Monday start

                        // 1. Determine the First Day of the Month
                        const d = new Date(currentDate);
                        const startOfMonth = new Date(d.getFullYear(), d.getMonth(), 1);

                        // 2. Find the First Day (Monday) of the week containing the 1st
                        const dayOfWeek = (startOfMonth.getDay() - firstDay + 7) % 7;
                        const firstWeekStart = new Date(startOfMonth);
                        firstWeekStart.setDate(firstWeekStart.getDate() - dayOfWeek);

                        // 3. Start Date = First Week Start - 7 Days (Previous Buffer)
                        const start = new Date(firstWeekStart);
                        start.setDate(start.getDate() - 7);

                        // 4. Determine End of Month
                        const endOfMonth = new Date(startOfMonth.getFullYear(), startOfMonth.getMonth() + 1, 0);

                        // 5. Find Last Day (Sunday) of the week containing the End of Month
                        const dayOfWeekEnd = (endOfMonth.getDay() - firstDay + 7) % 7;

                        const lastWeekEnd = new Date(endOfMonth);
                        lastWeekEnd.setDate(lastWeekEnd.getDate() + (6 - dayOfWeekEnd));

                        // 6. End Date = Last Week End + 8 Days (Next Buffer Week + 1 day for exclusive end)
                        const end = new Date(lastWeekEnd);
                        end.setDate(end.getDate() + 8);

                        return { start, end };
                    }
                }
            },

            // Dynamic Fetching on View Change
            datesSet: async (info) => {
                // TAGGING FIRST: Prevent flicker by hiding rows immediately
                const calEl = document.getElementById('calendar');
                if (calEl) {
                    const rows = Array.from(calEl.querySelectorAll('.fc-daygrid-body table tr'));
                    if (rows.length > 0) {
                        rows.forEach((row, idx) => {
                            row.classList.remove('fc-row-prev-buffer', 'fc-row-next-buffer');
                            if (idx === 0) row.classList.add('fc-row-prev-buffer');
                            if (idx === rows.length - 1) row.classList.add('fc-row-next-buffer');
                        });
                    }

                    const chkPrev = document.getElementById('chk-add-prev-week');
                    const chkNext = document.getElementById('chk-add-next-week');
                    if (chkPrev) calEl.classList.toggle('show-prev-week', chkPrev.checked);
                    if (chkNext) calEl.classList.toggle('show-next-week', chkNext.checked);

                    // CUSTOM TITLE LOGIC: Robust MutationObserver approach
                    // Calculate expected title
                    const middleTimestamp = (info.start.getTime() + info.end.getTime()) / 2;
                    const middleDate = new Date(middleTimestamp);
                    const year = middleDate.getFullYear();
                    const month = middleDate.getMonth() + 1;
                    const expectedTitle = `${year}년 ${month}월`;

                    const titleEl = document.querySelector('.fc-toolbar-title');
                    if (titleEl) {
                        // 1. Set immediately
                        if (titleEl.textContent !== expectedTitle) {
                            titleEl.textContent = expectedTitle;
                        }

                        // 2. Enforce via Observer (prevent FC from overwriting)
                        if (!this._titleObserver) { // Attach only once per instance logic
                            this._titleObserver = new MutationObserver((mutations) => {
                                if (titleEl.textContent !== expectedTitle) {
                                    // Temporarily disconnect to avoid infinite loop
                                    this._titleObserver.disconnect();
                                    titleEl.textContent = expectedTitle;
                                    this._titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
                                }
                            });
                            this._titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
                        } else {
                            // Update the target text expected by the existing observer? 
                            // Actually, simpler to just disconnect and reconnect with new closure if needed, 
                            // OR simply let the datesSet re-run trigger the set. 
                            // But since the closure captures `expectedTitle`, we should re-create the observer or update a shared ref.
                            // Simpler: Disconnect old, create new.
                            this._titleObserver.disconnect();
                            this._titleObserver = new MutationObserver((mutations) => {
                                if (titleEl.textContent !== expectedTitle) {
                                    this._titleObserver.disconnect();
                                    titleEl.textContent = expectedTitle;
                                    this._titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
                                }
                            });
                            this._titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
                        }
                    }
                }

                await this.refreshCalendarData(info.start, info.end);

                this.distributeVerticalSpace();

                // ROBUST SCROLL RESET: Ensure we start at the top
                // Delay to ensure it runs after distributeVerticalSpace's RAF and internal resizing
                setTimeout(() => {
                    // 1. Main Content Container
                    const mainContent = document.getElementById('main-content');
                    if (mainContent) mainContent.scrollTop = 0;

                    // 2. Window (Fallback)
                    window.scrollTo(0, 0);

                    // 3. FullCalendar Internal Scroller (The most likely culprit for daygrid overflow)
                    const scrollers = document.querySelectorAll('.fc-scroller');
                    scrollers.forEach(el => el.scrollTop = 0);
                }, 100);
            },

            // Custom Classes for Red Dates
            // Custom Classes for Red Dates & Other Month Dates
            dayCellClassNames: (arg) => {
                const classes = [];

                // 1. Check for Other Month (Extended View only)
                if (arg.view.type === 'extendedMonth') {
                    const start = arg.view.activeStart.getTime();
                    const end = arg.view.activeEnd.getTime();
                    const middleTimestamp = (start + end) / 2;
                    const middleDate = new Date(middleTimestamp);

                    const currentMonth = middleDate.getMonth();
                    const currentYear = middleDate.getFullYear();

                    if (arg.date.getMonth() !== currentMonth || arg.date.getFullYear() !== currentYear) {
                        classes.push('is-other-month');
                    }
                }

                const dateStr = this.formatLocal(arg.date);
                const data = this.state.calendarData || { redDayMap: {}, holidayMap: {} };
                const day = arg.date.getDay();

                // 2. Forced Red (Holidays, Special Red Days)
                if (data.redDayMap && data.redDayMap[dateStr]) classes.push('is-holiday');

                // 3. Weekends (Sunday=0, Saturday=6)
                else if (day === 0 || day === 6) classes.push('is-holiday');

                return classes;
            },

            // Custom Content (Delegated to renderCalendarCell)
            dayCellContent: (arg) => {
                return this.renderCalendarCell(arg);
            },

            dayCellDidMount: (arg) => {
                // Remove default FullCalendar containers that might cause whitespace or layout issues
                const eventsContainer = arg.el.querySelector('.fc-daygrid-day-events');
                // const bottomContainer = arg.el.querySelector('.fc-daygrid-day-bottom'); // KEEP: Used for spacing
                const topContainer = arg.el.querySelector('.fc-daygrid-day-top'); // Original date header
                if (eventsContainer) eventsContainer.remove();
                // if (bottomContainer) bottomContainer.remove();
                if (topContainer) topContainer.remove();
            },

            windowResize: (view) => {
                this.distributeVerticalSpace();
            },
            dateClick: (info) => {
                this.openScheduleModal(null, info.dateStr);
            }
        });

        this.state.calendar = calendar;
        calendar.render();

        // [SYNC] Clear initialDate so it doesn't stick
        this.state.initialDate = null;

        // Force size update for flexbox environments
        // Force size update for flexbox environments
        setTimeout(() => {
            calendar.updateSize();
            // distributeVerticalSpace is already called by datesSet, so we don't need it here
        }, 0);

        // 4. Weekend Toggle Initialization
        const weekendChk = document.getElementById('chk-show-weekends');
        if (weekendChk) {
            // Load preference
            const showWeekends = localStorage.getItem('calendar-show-weekends') === 'true';
            weekendChk.checked = showWeekends;
            calendar.setOption('weekends', showWeekends);

            weekendChk.addEventListener('change', (e) => {
                const isChecked = e.target.checked;
                calendar.setOption('weekends', isChecked);
                localStorage.setItem('calendar-show-weekends', isChecked);
            });
        }

        // 5. Week Expansion Listeners
        const chkPrev = document.getElementById('chk-add-prev-week');
        const chkNext = document.getElementById('chk-add-next-week');

        if (chkPrev) {
            chkPrev.addEventListener('change', (e) => {
                calendarEl.classList.toggle('show-prev-week', e.target.checked);
                this.distributeVerticalSpace();
            });
        }
        if (chkNext) {
            chkNext.addEventListener('change', (e) => {
                calendarEl.classList.toggle('show-next-week', e.target.checked);
                this.distributeVerticalSpace();
            });
        }

        // 3. Search Initialization
        this.bindCalendarSearch();

        // 5. Button Bindings (Header)
        const btnAdd = document.getElementById('btn-add-schedule');
        if (btnAdd) {
            btnAdd.onclick = () => this.openScheduleModal();
        }

        const btnPrint = document.getElementById('btn-print-modal');
        if (btnPrint) {
            btnPrint.onclick = () => this.openPrintModal();
        }
    },

    // --- List View Logic ---

    initListView: async function () {
        // 1. Initial State
        const today = new Date();
        const d = new Date(today);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust to Monday
        const monday = new Date(d.setDate(diff));
        
        if (!this.state.listViewStart) {
            this.state.listViewStart = monday;
        }
        if (!this.state.listViewWeeks) {
            this.state.listViewWeeks = 1; // Default 1 week
        }

        // 2. Fetch Data (Settings & Depts)
        const settings = await this.fetchSettings();
        // Set School Name
        const schoolNameEl = document.getElementById('list-school-name');
        const schoolNameScreenEl = document.getElementById('list-school-name-screen');
        // Prefer full_name_kr > school_name > "학교"
        const sName = settings.full_name_kr || settings.school_name || "학교명 미설정";
        if (schoolNameEl) schoolNameEl.textContent = sName;
        if (schoolNameScreenEl) schoolNameScreenEl.textContent = sName;

        this.state.departments = await this.fetchDepartments();

        // 3. Bind Controls
        const btnPrev = document.getElementById('btn-list-prev');
        const btnNext = document.getElementById('btn-list-next');
        const btnToday = document.getElementById('btn-list-today');
        const btnPrint = document.getElementById('btn-list-print');
        const btnCalendar = document.getElementById('btn-list-calendar'); // New Button

        const moveWeek = (offset) => {
            const current = new Date(this.state.listViewStart);
            current.setDate(current.getDate() + (offset * 7));
            this.state.listViewStart = current;
            this.renderListView();
        };

        if (btnPrev) btnPrev.onclick = () => moveWeek(-1);
        if (btnNext) btnNext.onclick = () => moveWeek(1);
        if (btnToday) btnToday.onclick = () => {
            const t = new Date();
            const day = t.getDay();
            const diff = t.getDate() - day + (day === 0 ? -6 : 1);
            this.state.listViewStart = new Date(t.setDate(diff));
            this.renderListView();
        };

        if (btnPrint) {
            btnPrint.onclick = () => {
                this.openPrintModal('list');
            };
        }

        if (btnCalendar) {
            btnCalendar.onclick = () => {
                this.navigate('calendar');
            };
        }

        // --- Dropdown Navigation ---
        const selYear = document.getElementById('list-nav-year');
        const selMonth = document.getElementById('list-nav-month');
        
        if (selYear && selMonth) {
            // Populate Year (Current +/- 2)
            const currYear = new Date().getFullYear();
            selYear.innerHTML = '';
            for (let y = currYear - 2; y <= currYear + 2; y++) {
                const opt = document.createElement('option');
                opt.value = y;
                opt.textContent = `${y}년`;
                selYear.appendChild(opt);
            }

            // Populate Month
            selMonth.innerHTML = '';
            for (let m = 1; m <= 12; m++) {
                const opt = document.createElement('option');
                opt.value = m;
                opt.textContent = `${m}월`;
                selMonth.appendChild(opt);
            }

            // Bind Events
            // Year: Move to Jan 1st of selected year
            selYear.onchange = () => {
                const y = parseInt(selYear.value);
                // 1st week of Jan
                const d = new Date(y, 0, 1);
                const day = d.getDay();
                const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
                this.state.listViewStart = new Date(d.setDate(diff));
                
                // Reset month to Jan
                selMonth.value = 1;
                this.renderListView();
            };

            // Month: Move to 1st week of selected month in current year
            selMonth.onchange = () => {
                const y = parseInt(selYear.value); // Use currently selected year
                const m = parseInt(selMonth.value);
                // 1st day of month
                const d = new Date(y, m - 1, 1);
                const day = d.getDay();
                const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
                this.state.listViewStart = new Date(d.setDate(diff));
                this.renderListView();
            };
        }

        // 1-Week / 2-Week Toggle
        const btn1Week = document.getElementById('btn-list-1week');
        const btn2Weeks = document.getElementById('btn-list-2weeks');

        const updateToggleUI = () => {
            const is2Weeks = this.state.listViewWeeks === 2;
            if (btn1Week) {
                btn1Week.className = is2Weeks 
                    ? "px-2 py-0.5 text-xs font-medium rounded text-gray-500 hover:text-gray-900" 
                    : "px-2 py-0.5 text-xs font-medium rounded bg-white shadow text-gray-800";
            }
            if (btn2Weeks) {
                btn2Weeks.className = is2Weeks 
                    ? "px-2 py-0.5 text-xs font-medium rounded bg-white shadow text-gray-800"
                    : "px-2 py-0.5 text-xs font-medium rounded text-gray-500 hover:text-gray-900";
            }
        };

        if (btn1Week) {
            btn1Week.onclick = () => {
                this.state.listViewWeeks = 1;
                updateToggleUI();
                this.renderListView();
            };
        }
        if (btn2Weeks) {
            btn2Weeks.onclick = () => {
                this.state.listViewWeeks = 2;
                updateToggleUI();
                this.renderListView();
            };
        }
        updateToggleUI();

        // 4. Render
        await this.renderListView();
    },

    renderListView: async function () {
        const container = document.getElementById('list-view-container');
        if (!container) return;

        // Visual Feedback
        container.innerHTML = '<div class="flex justify-center p-8"><div class="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600"></div></div>';
        const rangeDisplay = document.getElementById('list-date-range');
        const printRangeDisplay = document.getElementById('list-print-date-range');
        const screenRangeDisplay = document.getElementById('list-screen-date-range');

        // 1. Calculate Week Range
        const weeks = this.state.listViewWeeks || 1;
        const start = new Date(this.state.listViewStart);
        // Correct for Monday start if needed, but state.listViewStart is usually Mon 00:00
        const end = new Date(start);
        end.setDate(end.getDate() + (weeks * 7) - 1); // Sunday of last week

        // Update Range Display
        const fmt = (d) => `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')}`;
        // [MOVED UP & FIXED] Sync Dropdowns with Hysteresis
        const selYear = document.getElementById('list-nav-year');
        const selMonth = document.getElementById('list-nav-month');
        
        let currentViewYear = start.getFullYear();
        let currentViewMonth = start.getMonth() + 1; // 1-indexed

        if (selYear && selMonth) {
            // Priority 1: Respect User's Current Selection if it matches ANY visible day
            // This enables viewing either 'Feb' (Old Year) or 'Mar' (New Year) for boundary weeks (e.g., Feb 24 - Mar 2).
            const currSelY = parseInt(selYear.value);
            const currSelM = parseInt(selMonth.value);
            
            let isSelectionValid = false;
            // Iterate through visible days (max 14 days)
            const checkEnd = new Date(end);
            let dIter = new Date(start);
            while(dIter <= checkEnd) {
                if (dIter.getFullYear() === currSelY && (dIter.getMonth() + 1) === currSelM) {
                    isSelectionValid = true;
                    break;
                }
                dIter.setDate(dIter.getDate() + 1);
            }

            if (isSelectionValid) {
                // Keep current selection (Hysteresis)
                currentViewYear = currSelY;
                currentViewMonth = currSelM;
            } else {
                // Priority 2: Auto-switch to Representative Day (Thursday)
                const targetDate = new Date(start);
                targetDate.setDate(targetDate.getDate() + 3); 
                currentViewYear = targetDate.getFullYear();
                currentViewMonth = targetDate.getMonth() + 1;
            }

            // Sync UI
            if (selYear.querySelector(`option[value="${currentViewYear}"]`)) selYear.value = currentViewYear;
            else selYear.value = currentViewYear;
            selMonth.value = currentViewMonth;
        }

        // [FIX] Determine Academic Year based on SYNCED DROPDOWN VALUE
        const targetAcademicYear = (currentViewMonth < 3) ? (currentViewYear - 1) : currentViewYear;
        const settings = await this.fetchSettings(targetAcademicYear); 
        const basicSchedules = settings.basic_schedules || [];
        const sName = settings.full_name_kr || settings.school_name || "학교명 미설정";

        // Helper: Get Holiday String for a Date Range
        const getHolidayString = (rStart, rEnd) => {
            const hInfos = [];
            const rStartStr = rStart.toISOString().split('T')[0];
            const rEndStr = rEnd.toISOString().split('T')[0];
            
            basicSchedules.forEach(b => {
                if (b.weekend === null) return; // Skip if weekend column is explicit NULL (User Request)
                const isHoliday = b.is_holiday || b.type === 'holiday' || b.name.includes('재량휴업') || b.name.includes('대체공휴일');
                if (isHoliday) {
                    const bStart = b.start_date;
                    const bEnd = b.end_date || b.start_date;
                    if (bStart <= rEndStr && (bEnd || bStart) >= rStartStr) {
                         const hDate = new Date(bStart);
                         hInfos.push(`${hDate.getMonth() + 1}.${hDate.getDate()}: ${b.name}`);
                    }
                }
            });
            return hInfos.length > 0 ? ` <span style="color:red; font-size:11px; font-weight:normal;">(${hInfos.join(', ')})</span>` : '';
        };

        // Helper: Generate Page Header (Print & Screen)
        const generateHeaderHtml = (rStart, rEnd, isScreenOnly = false, isPrintOnly = false) => {
            const rangeBase = `${fmt(rStart)} ~ ${fmt(rEnd)}`;
            const holidays = getHolidayString(rStart, rEnd);
            // rangeFull removed, we separate them now
            
            let html = '';
            // Print Header
            if (!isScreenOnly) {
                html += `
                    <div class="text-center mb-4 hidden print:block">
                        <h1 class="text-3xl font-bold border-b-2 border-black pb-4 mb-2">주간 계획서</h1>
                        <div class="flex justify-between items-end">
                            <div class="text-[16px] font-bold">${rangeBase}</div>
                            <div class="text-[16px] font-bold">${sName}</div>
                        </div>
                        <div class="text-left mt-1 text-[11px] font-bold">${holidays}</div>
                    </div>
                `;
            }
            // Screen Header
            if (!isPrintOnly) {
                html += `
                    <div class="text-center mb-8 print:hidden">
                        <h1 class="text-3xl font-bold border-b-2 border-gray-800 pb-4 mb-2">주간 계획서</h1>
                        <div class="flex justify-between items-end">
                            <div class="text-[16px] font-bold text-gray-700">${rangeBase}</div>
                            <div class="text-[16px] font-bold text-gray-700">${sName}</div>
                        </div>
                        <div class="text-left mt-1 text-[11px] font-bold">${holidays}</div>
                    </div>
                `;
            }
            return html;
        };

        // Update Toolbar Range
        if (rangeDisplay) {
            rangeDisplay.innerHTML = `${fmt(start)} ~ ${fmt(end)}`; // Removed holiday text
        }



        // 2. Fetch Data
        const schedules = await this.fetchSchedules();
        const departments = this.state.departments || [];

        // 3. Process Days
        const dates = [];
        let curr = new Date(start);
        const totalDays = weeks * 7;
        for(let i=0; i<totalDays; i++) {
            dates.push(new Date(curr));
            curr.setDate(curr.getDate() + 1);
        }

        const dayHtmls = []; 
        const dayNames = ['일', '월', '화', '수', '목', '금', '토'];

        const checkOverlap = (evStart, evEnd, targetDateStr) => {
            if (evStart === targetDateStr) return true;
            if (!evEnd) return false;
            return (targetDateStr >= evStart && targetDateStr <= evEnd);
        };

        for (const dateObj of dates) {
            const dateStr = this.formatLocal(dateObj);
            const dayName = dayNames[dateObj.getDay()];
            
            const isDayOff = !this.isSchoolDay(dateObj, basicSchedules);

            const dailySchedules = schedules.filter(s => {
                let sStart = s.start_date;
                let sEnd = s.end_date || s.start_date;
                if (sStart.includes('T')) sStart = sStart.split('T')[0];
                if (sEnd.includes('T')) sEnd = sEnd.split('T')[0];
                
                const overlaps = checkOverlap(sStart, sEnd, dateStr);
                if (!overlaps) return false;

                // Holiday/Weekend Filter:
                // If it is a non-school day (Weekend or Holiday), 
                // ONLY show schedules that have 'weekend' flag set.
                if (isDayOff && !s.weekend) {
                    return false;
                }

                return true;
            });

            const dailyBasics = [];
            basicSchedules.forEach(b => {
                if (b.type === 'term' || b.type === 'vacation') return; 
                const bStart = b.start_date;
                const bEnd = b.end_date || b.start_date;
                if (checkOverlap(bStart, bEnd, dateStr)) {
                    dailyBasics.push(b);
                }
            });

            const groups = {};
            dailySchedules.forEach(s => {
                const deptName = s.dept_name || '기타';
                if (!groups[deptName]) groups[deptName] = [];
                groups[deptName].push({ title: s.title, desc: s.description });
            });

            if (dailyBasics.length > 0) {
                let targetDept = departments.find(d => d.dept_name.includes('교무'));
                const deptName = targetDept ? targetDept.dept_name : '학교 행사';
                if (!groups[deptName]) groups[deptName] = [];
                
                // [FIX] Deduplication for Exam Blocks (prevent 4 lines for same exam)
                const addedTitles = new Set();
                
                dailyBasics.forEach(b => {
                   let title = b.name || b.title;
                   if (b.type === 'exam') title = `[고사] ${b.name}`; // [FIX] Use b.name instead of b.title
                   if (b.is_holiday || b.type === 'holiday') title = `[공휴일] ${b.name}`;
                   
                   if (!addedTitles.has(title)) {
                       groups[deptName].push({ title: title, desc: '' });
                       addedTitles.add(title);
                   }
                });
            }

            const hasEvents = Object.keys(groups).length > 0;
            const isRedDay = dateObj.getDay() === 0;

            let dayHtml = '';
            if (hasEvents) {
                const yearStr = dateObj.getFullYear();
                const monthStr = String(dateObj.getMonth() + 1).padStart(2,'0');
                const dateNumStr = String(dateObj.getDate()).padStart(2,'0');
                
                dayHtml += `
                    <div class="list-day-block break-inside-avoid">
                        <div class="border-t-[3px] border-black bg-white pt-1 px-1 mb-2">
                            <span class="text-[12px] leading-[1.3] font-bold ${isRedDay ? 'text-red-600' : 'text-gray-900'}">
                                ${yearStr}년 ${monthStr}월 ${dateNumStr}일 (${dayName}요일)
                            </span>
                        </div>
                        <div class="space-y-4 pl-2">
                `;

                const sortedDeptNames = Object.keys(groups).sort((a, b) => {
                    const ordA = departments.find(d => d.dept_name === a)?.sort_order ?? 999;
                    const ordB = departments.find(d => d.dept_name === b)?.sort_order ?? 999;
                    return ordA - ordB;
                });

                sortedDeptNames.forEach(deptName => {
                    dayHtml += `
                        <div class="list-dept-group">
                            <div class="font-bold text-[11px] leading-[1.3] text-gray-800 mb-1 flex items-center gap-1">
                                <span class="text-[11px]">◈</span> ${deptName}
                            </div>
                            <ul class="list-disc list-inside text-[11px] leading-[1.3] text-gray-700 pl-4 space-y-[3px]">
                    `;
                    groups[deptName].forEach(ev => {
                        dayHtml += `<li><span class="font-medium text-gray-900">${ev.title}</span>${ev.desc ? ` <span class="text-gray-500 text-[11px]">(${ev.desc})</span>` : ''}</li>`;
                    });
                    dayHtml += `</ul></div>`;
                });
                dayHtml += `</div></div>`;
            }
            dayHtmls.push(dayHtml);
        }

        // 4. Assembly
        let finalHtml = '';
        if (weeks === 1) {
            finalHtml = `
                ${generateHeaderHtml(start, end)}
                <div class="list-1week-print-cols">
                    ${dayHtmls.join('')}
                </div>
            `;
        } else {
            const w1Start = new Date(start);
            const w1End = new Date(start); w1End.setDate(w1End.getDate() + 6);
            const w2Start = new Date(start); w2Start.setDate(w2Start.getDate() + 7);
            const w2End = new Date(start); w2End.setDate(w2End.getDate() + 13);
            
            const week1Html = dayHtmls.slice(0, 7).join('');
            const week2Html = dayHtmls.slice(7, 14).join('');

            finalHtml = `
                <!-- Screen Version -->
                <div class="print:hidden">
                    ${generateHeaderHtml(start, end)}
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-8 items-start">
                        <div class="list-col-week1">${week1Html}</div>
                        <div class="list-col-week2">${week2Html}</div>
                    </div>
                </div>

                <!-- Print Version -->
                <div class="hidden print:block">
                    <div>
                        ${generateHeaderHtml(w1Start, w1End, false, true)}
                        <div class="list-1week-print-cols">${week1Html}</div>
                    </div>
                    <div style="break-before: page;">
                        ${generateHeaderHtml(w2Start, w2End, false, true)}
                        <div class="list-1week-print-cols">${week2Html}</div>
                    </div>
                </div>
            `;
        }

        container.innerHTML = finalHtml;

    },

    // --- Dept List View ---

    initDeptListView: async function () {
        if (!this.state.deptViewDate) {
            const today = new Date();
            this.state.deptViewDate = new Date(today.getFullYear(), today.getMonth(), 1);
        }
        const date = this.state.deptViewDate;
        const mm = date.getMonth() + 1;
        const y = date.getFullYear();
        const ay = (mm < 3) ? y - 1 : y;

        this.state.currentSettings = await this.fetchSettings(ay);
        this.state.departments = await this.fetchDepartments(ay);

        const btnPrev = document.getElementById('btn-dept-prev');
        const btnNext = document.getElementById('btn-dept-next');
        const btnToday = document.getElementById('btn-dept-today');
        const btnPrint = document.getElementById('btn-dept-print');

        if (btnPrev) btnPrev.onclick = () => {
            const current = new Date(this.state.deptViewDate);
            current.setMonth(current.getMonth() - 1);
            this.state.deptViewDate = current;
            this.initDeptListView();
        };
        if (btnNext) btnNext.onclick = () => {
            const current = new Date(this.state.deptViewDate);
            current.setMonth(current.getMonth() + 1);
            this.state.deptViewDate = current;
            this.initDeptListView();
        };
        if (btnToday) btnToday.onclick = () => {
            const t = new Date();
            this.state.deptViewDate = new Date(t.getFullYear(), t.getMonth(), 1);
            this.initDeptListView();
        };
        if (btnPrint) btnPrint.onclick = () => this.openPrintModal('dept_list');

        const selYear = document.getElementById('dept-nav-year');
        const selMonth = document.getElementById('dept-nav-month');
        if (selYear && selMonth) {
            const currYear = new Date().getFullYear();
            selYear.innerHTML = '';
            for (let y = currYear - 2; y <= currYear + 2; y++) {
                const opt = document.createElement('option');
                opt.value = y;
                opt.textContent = `${y}년`;
                selYear.appendChild(opt);
            }
            selMonth.innerHTML = '';
            for (let m = 1; m <= 12; m++) {
                const opt = document.createElement('option');
                opt.value = m;
                opt.textContent = `${m}월`;
                selMonth.appendChild(opt);
            }
            selYear.onchange = () => {
                this.state.deptViewDate = new Date(parseInt(selYear.value), parseInt(selMonth.value) - 1, 1);
                this.initDeptListView();
            };
            selMonth.onchange = () => {
                this.state.deptViewDate = new Date(parseInt(selYear.value), parseInt(selMonth.value) - 1, 1);
                this.initDeptListView();
            };
        }
        this.renderDeptListView();
    },

    renderDeptListView: async function (customStart, customEnd) {
        const thead = document.getElementById('dept-view-thead');
        const tbody = document.getElementById('dept-view-tbody');
        const selYear = document.getElementById('dept-nav-year');
        const selMonth = document.getElementById('dept-nav-month');
        const wrapper = document.getElementById('dept-view-table-scroll');

        if (!thead || !tbody) return;

        const date = this.state.deptViewDate;
        const year = date.getFullYear();
        const month = date.getMonth();
        if (selYear) selYear.value = year;
        if (selMonth) selMonth.value = month + 1;

        const activeDepts = (this.state.departments || []).filter(d => d.is_active);
        
        // Determine Range
        const startOfMonth = new Date(year, month, 1);
        const endOfMonth = new Date(year, month + 1, 0);
        
        const finalStart = customStart ? new Date(customStart) : startOfMonth;
        const finalEnd = customEnd ? new Date(customEnd) : endOfMonth;

        // Populate Print Header
        const printRange = document.getElementById('dept-print-range');
        const printSchool = document.getElementById('dept-print-school');

        if (printRange) {
            printRange.textContent = `${this.formatLocal(finalStart)} ~ ${this.formatLocal(finalEnd)}`;
        }
        if (printSchool) {
            const s = this.state.currentSettings;
            printSchool.textContent = s ? (s.full_name_kr || s.school_name || "") : "";
        }
        
        // 1. Header
        let headerHtml = `<tr><th class="col-date" style="padding: 0 4px; vertical-align: middle; box-shadow: inset 0 -5px 0 #6b7280; height: 50px;">날짜</th>`;
        activeDepts.forEach(d => {
            const color = d.dept_color || '#ccc';
            const shortName = d.dept_short || d.dept_name.substring(0, 2);
            headerHtml += `
                <th class="col-dept" style="padding: 0 4px; vertical-align: middle; box-shadow: inset 0 -5px 0 ${color}; height: 50px;">
                    <div class="print:hidden">${d.dept_name}</div>
                    <div class="hidden print:block">${shortName}</div>
                </th>`;
        });
        headerHtml += `</tr>`;
        thead.innerHTML = headerHtml;

        // 2. Data
        const startStr = this.formatLocal(finalStart);
        const endStr = this.formatLocal(finalEnd);

        let query = window.SupabaseClient.supabase
            .from('schedules')
            .select('*')
            .gte('start_date', startStr)
            .lte('start_date', endStr);

        // Guest visibility filter
        if (!this.state.user) {
            query = query.eq('visibility', 'public');
        }

        const { data: schedules } = await query;

        const mm = month + 1;
        const ay = (mm < 3) ? year - 1 : year;
        const holidays = this.calculateMergedHolidays(ay);

        let bodyHtml = '';
        const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
        
        // Loop from finalStart to finalEnd
        let curr = new Date(finalStart);
        while (curr <= finalEnd) {
            const d = curr.getDate();
            const dateStr = this.formatLocal(curr);
            const dayNum = curr.getDay();
            const holidayName = holidays[dateStr];
            
            let rowClass = '';
            if (dayNum === 0) rowClass = 'row-sunday';
            else if (dayNum === 1) rowClass = 'row-monday'; // Assign Monday class
            else if (dayNum === 6) rowClass = 'row-saturday';
            
            // Append holiday class instead of overwriting, using space separator
            if (holidayName) {
                rowClass = rowClass ? `${rowClass} row-holiday` : 'row-holiday';
            }

            bodyHtml += `<tr class="${rowClass}">`;
            bodyHtml += `<td class="col-date">${d}<br><span class="text-[10px]">${dayNames[dayNum]}</span></td>`;
            activeDepts.forEach(dept => {
                // 1. Get DB Schedules (Clone to allow injection)
                let deptSchedules = (schedules || []).filter(s => s.dept_id === dept.id && s.start_date === dateStr);
                // Create a mutable copy if filter returns a new array anyway, but let's be explicit we treat it as mutable list
                deptSchedules = [...deptSchedules];

                // 2. Inject Virtual Events
                // Kyomu -> Holidays
                if (dept.dept_short === '교무' && holidayName) {
                    // Check duplicate to avoid double showing if manually added
                    if (!deptSchedules.some(s => s.title === holidayName)) {
                        deptSchedules.push({ title: holidayName, description: '' });
                    }
                }

                // Science -> Env Events
                if (dept.dept_short === '과학') {
                    const mm = String(curr.getMonth() + 1).padStart(2, '0');
                    const dd = String(curr.getDate()).padStart(2, '0');
                    const envKey = `${mm}-${dd}`;
                    const envEvent = this.FIXED_ENV_EVENTS[envKey];
                    
                    if (envEvent) {
                         if (!deptSchedules.some(s => s.title === envEvent)) {
                            deptSchedules.push({ title: envEvent, description: '' });
                        }
                    }
                }

                bodyHtml += `<td class="col-dept">`;
                deptSchedules.forEach(s => {
                    const desc = s.description ? ` (${s.description})` : '';
                    bodyHtml += `<div class="dept-event-item" style="border-left-color: ${dept.dept_color}">${s.title}${desc}</div>`;
                });
                bodyHtml += `</td>`;
            });
            bodyHtml += `</tr>`;
            
            curr.setDate(curr.getDate() + 1);
        }
        tbody.innerHTML = bodyHtml;

        // Reset scroll position on month change
        if (wrapper) wrapper.scrollTop = 0;
    },

    // --- Data Fetching ---

    fetchSettings: async function (targetYear = null) {
        let query = window.SupabaseClient.supabase
            .from('settings')
            .select('*');

        if (targetYear) {
            query = query.eq('academic_year', targetYear).maybeSingle();
        } else {
            query = query.order('academic_year', { ascending: false }).limit(1).single();
        }

        const { data: settings, error } = await query;
        if (error && error.code !== 'PGRST116') {
            console.error('Error fetching settings:', error);
            return {};
        }

        const result = settings || {};

        // Fetch Basic Schedules (DB Refactor)
        if (result.academic_year) {
            const { data: basicSchedules } = await window.SupabaseClient.supabase
                .from('basic_schedules')
                .select('*')
                .eq('academic_year', result.academic_year);

            result.basic_schedules = basicSchedules || [];
        }

        return result;
    },

    fetchDepartments: async function (year = null) {
        const targetYear = year || this.state.currentYear || new Date().getFullYear();

        const { data: results, error } = await window.SupabaseClient.supabase
            .from('departments')
            .select('*')
            .eq('academic_year', targetYear)
            .eq('is_active', true)
            .order('sort_order', { ascending: true });

        if (error) {
            console.error('Error fetching departments:', error);
            return [];
        }

        return results || [];
    },

    fetchSchedules: async function () {
        // Fetch all public schedules + visible internal ones
        let query = window.SupabaseClient.supabase.from('schedules').select('*');
        
        // Guest visibility filter
        if (!this.state.user) {
            query = query.eq('visibility', 'public');
        }

        const { data, error } = await query;

        if (error) console.error('Error fetching schedules:', error);
        return data || [];
    },

    // --- Data Transformation ---

    transformEvents: function (schedules, settings, departments, basicSchedules) {
        const events = [];

        // --- 1. Admin Event Deduplication Setup ---
        // We track all titles from Admin settings to skip duplicate DB schedules later.
        const normalize = (s) => (s || '').normalize('NFC').replace(/[\s\(\)\[\]\{\}\-\.~!@#$%^&*_=+|;:'",.<>?/]/g, '').toLowerCase();
        const adminEventMap = {}; // { 'YYYY-MM-DD': Set(normalizedTitles) }

        const addAdminRef = (date, name) => {
            if (!date || !name) return;
            if (!adminEventMap[date]) adminEventMap[date] = new Set();
            adminEventMap[date].add(normalize(name));
        };

        // basicSchedules is array of { type, code, name, start_date, end_date, is_holiday, academic_year }
        if (basicSchedules && Array.isArray(basicSchedules)) {
            // A-0. Collect all holiday dates first to use for exam filtering
            const holidayDates = new Set();
            basicSchedules.forEach(item => {
                if (item.is_holiday || item.type === 'holiday') {
                    if (item.start_date === item.end_date || !item.end_date) {
                        holidayDates.add(item.start_date);
                    } else {
                        let curr = this.parseLocal(item.start_date);
                        const last = this.parseLocal(item.end_date);
                        let l = 0;
                        while (curr <= last && l < 366) {
                            holidayDates.add(this.formatLocal(curr));
                            curr.setDate(curr.getDate() + 1);
                            l++;
                        }
                    }
                }
            });

            basicSchedules.forEach(item => {
                // --- 1.5 Academic Year Consistency Check ---
                // Basic schedules must fall within their academic year (Mar 1 to Feb 29 of next year)
                if (item.academic_year && item.start_date) {
                    const ay = parseInt(item.academic_year);
                    const ayStart = `${ay}-03-01`;
                    const ayEnd = `${ay + 1}-02-29`;
                    if (item.start_date < ayStart || item.start_date > ayEnd) {
                        return; // Skip ghost data inconsistent with its academic year
                    }
                }

                // Determine styling based on type
                let className = 'holiday-bg-event';
                let bgColor = '';
                let isExam = false;

                // Forced Holiday from DB flag
                if (item.is_holiday) {
                    className = 'holiday-bg-event';
                } else if (item.type === 'vacation') {
                    className = 'vacation-bg-event';
                } else if (item.type === 'term') {
                    className = 'event-term-text';
                } else if (item.type === 'holiday') {
                    className = 'holiday-bg-event';
                } else if (item.type === 'exam') {
                    isExam = true;
                    className = 'event-exam-text';
                    bgColor = 'transparent';
                } else if (item.type === 'event') {
                    // Major Events
                    className = 'event-major-text';
                    bgColor = 'transparent';
                }

                // Add to Reference Map
                if (item.start_date === item.end_date || !item.end_date) {
                    // Filter: Skip exams on weekends/holidays
                    if (isExam) {
                        const d = this.parseLocal(item.start_date);
                        const day = d.getDay();
                        if (day === 0 || day === 6 || holidayDates.has(item.start_date)) {
                            return; // Don't show exam info on non-school days
                        }
                    }

                    addAdminRef(item.start_date, item.name);
                    events.push({
                        start: item.start_date,
                        display: 'background',
                        title: '',
                        className: className,
                        backgroundColor: 'transparent', // Always transparent for FC, painted manually in renderer
                        allDay: true,
                        extendedProps: { label: item.name }
                    });
                } else {
                    // Range Event (Exams, Multi-day Events)
                    // We need to add refs for every day
                    let current = this.parseLocal(item.start_date);
                    const endDate = this.parseLocal(item.end_date);
                    let loop = 0;

                    while (current <= endDate && loop < 365) {
                        const dStr = this.formatLocal(current);

                        // Filter: Skip exams on weekends/holidays
                        if (isExam) {
                            const day = current.getDay();
                            if (day === 0 || day === 6 || holidayDates.has(dStr)) {
                                current.setDate(current.getDate() + 1);
                                loop++;
                                continue;
                            }
                        }

                        addAdminRef(dStr, item.name);
                        events.push({
                            start: dStr,
                            display: 'background',
                            title: '',
                            className: className,
                            backgroundColor: 'transparent', // Always transparent for FC, painted manually in renderer
                            allDay: true,
                            extendedProps: { label: item.name }
                        });
                        current.setDate(current.getDate() + 1);
                        loop++;
                    }
                }
            });

            // A-2. Standard Holiday Injection (Deduplicated)
            // Ensures legal holidays (Samil-jeol, etc) are shown only if NOT in DB.
            const ayCollection = new Set();
            basicSchedules.forEach(item => { if (item.academic_year) ayCollection.add(parseInt(item.academic_year)); });

            // If we have NO data at all for a range (e.g. browsing future year), fallback to current
            if (ayCollection.size === 0) ayCollection.add(this.state.currentYear || new Date().getFullYear());

            ayCollection.forEach(ay => {
                // IMPORTANT: If this year ALREADY has data in basicSchedules (from DB), 
                // it means the user has "initialized" or "saved" this year.
                // In this case, we respect the DB as the source of truth and skip auto-injection.
                const hasDbData = basicSchedules.some(item => parseInt(item.academic_year) === ay);
                if (hasDbData) return;

                const holidays = this.calculateMergedHolidays(ay);
                Object.entries(holidays).forEach(([dateStr, name]) => {
                    const names = name.split(", ");
                    names.forEach(n => {
                        if (adminEventMap[dateStr] && adminEventMap[dateStr].has(normalize(n))) return;

                        addAdminRef(dateStr, n);
                        events.push({
                            start: dateStr,
                            display: 'background',
                            title: '',
                            className: 'holiday-bg-event',
                            backgroundColor: 'transparent',
                            allDay: true,
                            extendedProps: { label: n }
                        });
                    });
                });
            });

            // A-3. Env Events (Fixed from App Constant)
            // These are NOT in DB currently, still calculated manually or should we move to DB?
            // Plan says "Recalculate Env Events", user didn't explicitly ask to DB them.
            // But logic says "Recalculate Env Events for newYear".
            // Let's keep them as code-based for now since they are permanent fixed dates (Earth Day etc)
            const yearVal = this.state.currentYear || new Date().getFullYear();
            const envs = this.FIXED_ENV_EVENTS || {};
            [yearVal - 1, yearVal, yearVal + 1].forEach(yVal => {
                Object.entries(envs).forEach(([mmdd, name]) => {
                    const mm = parseInt(mmdd.split('-')[0]);
                    const y = (mm < 3) ? yVal + 1 : yVal;
                    const dateStr = `${y}-${mmdd}`;
                    addAdminRef(dateStr, name);
                    events.push({
                        start: dateStr,
                        display: 'block',
                        title: name,
                        className: 'event-env-text',
                        backgroundColor: 'transparent',
                        borderColor: 'transparent',
                        textColor: '#16a34a',
                        allDay: true
                    });
                });
            });
        }

        // --- 3. Process Database Schedules (User created) ---
        const deptMap = {};
        if (departments) departments.forEach(d => deptMap[d.id] = d);

        if (schedules) {
            schedules.forEach(s => {
                // Deduplication
                const normTitle = normalize(s.title);
                const hasConflict = adminEventMap[s.start_date] && adminEventMap[s.start_date].has(normTitle);

                if (hasConflict) return;

                // GUEST VISIBILITY CHECK: Only show 'public'
                if (!this.state.user && s.visibility !== 'public') return;

                const dept = deptMap[s.dept_id] || {};
                events.push({
                    id: s.id,
                    title: s.title,
                    start: s.start_date,
                    end: s.end_date,
                    backgroundColor: dept.dept_color || '#3788d8',
                    borderColor: dept.dept_color || '#3788d8',
                    extendedProps: {
                        deptId: s.dept_id,
                        deptInfo: deptMap[s.dept_id] || { dept_name: '기타', dept_color: '#333' },
                        description: s.description,
                        visibility: s.visibility,
                        isPrintable: s.is_printable,
                        weekend: s.weekend
                    }
                });
            });
        }

        return events;
    },

    renderDeptFilters: function (departments) {
        const container = document.getElementById('dept-filter-list');
        if (!container) return;

        container.innerHTML = departments.map(d => `
            <div class="flex items-center gap-2">
                <input type="checkbox" id="dept-${d.id}" value="${d.id}" class="dept-checkbox rounded ${d.is_special ? 'text-purple-600' : 'text-blue-600'} focus:ring-purple-500" checked>
                <label for="dept-${d.id}" class="flex items-center gap-2 cursor-pointer w-full">
                    <span class="w-3 h-3 rounded-full" style="background-color: ${d.dept_color}"></span>
                    <span class="${d.is_special ? 'font-bold' : ''}">${d.dept_name}</span>
                </label>
            </div>
        `).join('');

        // Add Event Listeners
        container.querySelectorAll('.dept-checkbox').forEach(cb => {
            cb.addEventListener('change', () => {
                // Re-render events to trigger eventDidMount filtering
                // Or use internal filter API if available. 
                // For simplicity: refetch is expensive, so we just rerender existing events? 
                // FullCalendar doesn't have simple show/hide API for events without removing them.
                // Best simple appoach: 
                this.state.calendar.refetchEvents(); // This triggers eventDidMount again
            });
        });
    },

    // --- Modal & CRUD Logic ---

    openScheduleModal: async function (eventId = null, defaultDate = null) {
        // 1. Check Auth & Permissions
        if (!this.state.user) {
            alert('로그인이 필요한 기능입니다.');
            this.navigate('login');
            return;
        }

        const canEdit = this.state.role === 'admin' || this.state.role === 'head_teacher' || this.state.role === 'head';
        if (!canEdit) {
            alert('일정 등록/수정 권한이 없습니다.');
            return;
        }

        // 2. Load Modal Template
        const modalContainer = document.getElementById('modal-container');
        try {
            if (!this.state.templates['schedule']) {
                const response = await fetch('pages/modal-schedule.html');
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                this.state.templates['schedule'] = await response.text();
            }
            modalContainer.innerHTML = this.state.templates['schedule'];
            modalContainer.classList.remove('invisible');
        } catch (e) {
            console.error("Failed to load schedule modal", e);
            alert('모달을 불러오는 중 오류가 발생했습니다. 서버 연결을 확인해 주세요.\n(' + e.message + ')');
            return;
        }

        // 3. Setup Elements
        const form = document.getElementById('schedule-form');
        const titleInput = document.getElementById('sched-title');
        const startInput = document.getElementById('sched-start');
        const endInput = document.getElementById('sched-end');
        const deptSelect = document.getElementById('sched-dept');
        const visSelect = document.getElementById('sched-visibility');
        const descInput = document.getElementById('sched-desc');
        const printCheck = document.getElementById('sched-printable');
        const includeHolidaysCheck = document.getElementById('sched-include-holidays');
        const includeHolidaysWrapper = document.getElementById('include-holidays-wrapper');
        const btnDelete = document.getElementById('btn-delete');
        const visHint = document.getElementById('visibility-hint');

        // Recurrence Elements
        const repeatCheck = document.getElementById('sched-repeat');
        const recurSection = document.getElementById('recurrence-section'); // Wrapper
        const recurOptions = document.getElementById('recurrence-options');
        const rFreq = document.getElementById('sched-freq');
        const rUntil = document.getElementById('sched-until');

        // 4. Populate Departments
        deptSelect.innerHTML = this.state.departments.map(d =>
            `<option value="${d.id}">${d.dept_name}</option>`
        ).join('');

        // 5. Load Data (Edit Mode) or Defaults
        if (eventId) {
            document.getElementById('modal-title').textContent = '일정 수정';
            btnDelete.classList.remove('hidden');
            recurSection.classList.add('hidden'); // Hide recurrence on edit for simplicity in V1
            includeHolidaysWrapper.classList.add('hidden'); // Hide include holidays on edit

            const event = this.state.calendar.getEventById(eventId);
            if (event) {
                document.getElementById('schedule-id').value = eventId;
                titleInput.value = event.title;
                startInput.value = event.startStr;
                endInput.value = event.endStr || event.startStr;

                if (event.allDay && event.end) {
                    const d = new Date(event.end);
                    d.setDate(d.getDate() - 1);
                    endInput.value = d.toISOString().split('T')[0];
                }

                deptSelect.value = event.extendedProps.deptId;
                visSelect.value = event.extendedProps.visibility;
                descInput.value = event.extendedProps.description || '';
                printCheck.checked = event.extendedProps.isPrintable !== false;
                includeHolidaysCheck.checked = event.extendedProps.weekend === 'on';
            }
        } else {
            recurSection.classList.remove('hidden');

            // Check if defaultDate is a holiday or weekend
            const data = this.state.calendarData || { redDayMap: {} };
            const isHoliday = defaultDate && data.redDayMap && data.redDayMap[defaultDate];
            const isWeekend = defaultDate && ([0, 6].includes(new Date(defaultDate).getDay()));

            if (isHoliday || isWeekend) {
                includeHolidaysWrapper.classList.add('hidden');
            } else {
                includeHolidaysWrapper.classList.remove('hidden');
            }

            includeHolidaysCheck.checked = false; // Default: unchecked
            if (defaultDate) {
                startInput.value = defaultDate;
                endInput.value = defaultDate;
            } else {
                startInput.value = new Date().toISOString().split('T')[0];
                endInput.value = startInput.value;
            }
            // Init Repeat Options
            repeatCheck.checked = false;
            recurOptions.classList.add('hidden');
        }

        // 6. Event Listeners
        document.getElementById('btn-modal-close').onclick = () => this.closeModal();
        document.getElementById('btn-cancel').onclick = () => this.closeModal();

        repeatCheck.onchange = () => {
            if (repeatCheck.checked) {
                recurOptions.classList.remove('hidden');
                if (!rUntil.value) {
                    // Default until: 1 month later
                    const d = this.parseLocal(startInput.value);
                    d.setMonth(d.getMonth() + 1);
                    rUntil.value = this.formatLocal(d);
                }
            } else {
                recurOptions.classList.add('hidden');
            }
        };

        visSelect.onchange = () => {
            const hints = {
                'public': '모두에게 공개합니다.',
                'internal': '교직원에게만 공개됩니다.',
                'dept': '소속 부서원만 볼 수 있습니다.'
            };
            visHint.textContent = hints[visSelect.value] || '';
        };
        visSelect.onchange();

        btnDelete.onclick = async () => {
            if (confirm('정말 삭제하시겠습니까?')) {
                const { error } = await window.SupabaseClient.supabase
                    .from('schedules')
                    .delete()
                    .eq('id', document.getElementById('schedule-id').value);

                if (error) {
                    alert('삭제 실패: ' + error.message);
                } else {
                    this.logAction('DELETE', 'schedules', document.getElementById('schedule-id').value, { title: titleInput.value });
                    this.closeModal();
                    this.initCalendar();
                }
            }
        };

        form.onsubmit = async (e) => {
            e.preventDefault();

            const scheduleId = document.getElementById('schedule-id').value;
            const selectedDeptOption = deptSelect.options[deptSelect.selectedIndex];
            const deptName = selectedDeptOption ? selectedDeptOption.text : '';

            const baseData = {
                title: titleInput.value,
                dept_id: deptSelect.value,
                dept_name: deptName, // Store name for recovery
                visibility: visSelect.value,
                description: descInput.value,
                is_printable: printCheck.checked,
                weekend: includeHolidaysCheck.checked ? 'on' : null,
                author_id: this.state.user.id
            };

            const startDateStr = startInput.value;
            const endDateStr = endInput.value;

            // Recurrence Generation
            const isRecurring = !scheduleId && repeatCheck.checked;

            const btnSave = document.getElementById('btn-save');
            btnSave.disabled = true;
            btnSave.textContent = isRecurring ? '반복 일정 생성 중...' : '저장 중...';

            let batchData = [];

            if (isRecurring) {
                const untilStr = rUntil.value;
                const freq = rFreq.value;

                if (untilStr <= startDateStr) {
                    alert('반복 종료일은 시작일 이후여야 합니다.');
                    btnSave.disabled = false;
                    return;
                }

                // Calculate Duration
                const d1 = new Date(startDateStr);
                const d2 = new Date(endDateStr);
                const durationMs = d2 - d1;

                let curr = new Date(startDateStr);
                const until = new Date(untilStr);
                let limit = 0;

                while (curr <= until && limit < 52) { // Safety limit 52 (1 year weekly)
                    const loopStart = curr.toISOString().split('T')[0];
                    const loopEnd = new Date(curr.getTime() + durationMs).toISOString().split('T')[0];

                    batchData.push({
                        ...baseData,
                        start_date: loopStart,
                        end_date: loopEnd
                    });

                    // Next Step
                    if (freq === 'weekly') curr.setDate(curr.getDate() + 7);
                    else if (freq === 'biweekly') curr.setDate(curr.getDate() + 14);
                    else if (freq === 'monthly') curr.setMonth(curr.getMonth() + 1);

                    limit++;
                }

                if (batchData.length === 0) batchData.push({ ...baseData, start_date: startDateStr, end_date: endDateStr });

            } else {
                batchData.push({
                    ...baseData,
                    start_date: startDateStr,
                    end_date: endDateStr
                });
            }

            let result;
            if (scheduleId) {
                // UPDATE (Single)
                result = await window.SupabaseClient.supabase
                    .from('schedules')
                    .update(batchData[0])
                    .eq('id', scheduleId)
                    .select();
            } else {
                // INSERT (Maybe Batch)
                result = await window.SupabaseClient.supabase
                    .from('schedules')
                    .insert(batchData)
                    .select();
            }

            if (result.error) {
                console.error(result.error);
                alert('저장 실패: ' + result.error.message);
                btnSave.disabled = false;
                btnSave.textContent = '저장';
            } else {
                const action = scheduleId ? 'UPDATE' : 'INSERT';
                // Log only first ID or special bulk log
                if (batchData.length > 1) {
                    this.logAction('RECUR_INSERT', 'schedules', null, { count: batchData.length, title: baseData.title });
                } else {
                    const id = scheduleId || result.data[0].id;
                    this.logAction(action, 'schedules', id, { title: baseData.title, dept: baseData.dept_id });
                }

                this.closeModal();
                this.initCalendar();
            }
        };
    },

    closeModal: function () {
        const modalContainer = document.getElementById('modal-container');
        modalContainer.classList.add('invisible');
        modalContainer.innerHTML = '';
    },

    // --- Print Logic ---

    openPrintModal: async function (mode = 'calendar') {
        const modalContainer = document.getElementById('modal-container');
        try {
            if (!this.state.templates['print']) {
                const response = await fetch('pages/modal-print.html');
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                this.state.templates['print'] = await response.text();
            }
            modalContainer.innerHTML = this.state.templates['print'];
            modalContainer.classList.remove('invisible');
            
            // Handle Mode
            if (mode === 'list') {
                const viewInput = document.querySelector('input[name="print-view"]');
                if (viewInput) viewInput.value = 'weekly_plan'; // Distinguish from 'list' (calendar listMonth)
                
                const viewTitle = document.getElementById('print-view-title'); 
                if (viewTitle) viewTitle.textContent = '리스트형 (주간 계획서)';

                const viewIcon = document.getElementById('print-view-icon');
                if (viewIcon) viewIcon.textContent = 'summarize';

                // Default A4 Portrait for Weekly Plan usually
                const orientSelect = document.getElementById('print-orient');
                if (orientSelect) orientSelect.value = 'portrait';
                const sizeSelect = document.getElementById('print-size');
                if (sizeSelect) sizeSelect.value = 'A4';
            } else if (mode === 'dept_list') {
                const viewInput = document.querySelector('input[name="print-view"]');
                if (viewInput) viewInput.value = 'dept_list';
                
                const viewTitle = document.getElementById('print-view-title'); 
                if (viewTitle) viewTitle.textContent = '부서별 일정 (월간)';

                const viewIcon = document.getElementById('print-view-icon');
                if (viewIcon) viewIcon.textContent = 'table_view';

                const orientSelect = document.getElementById('print-orient');
                if (orientSelect) orientSelect.value = 'landscape';
                const sizeSelect = document.getElementById('print-size');
                if (sizeSelect) sizeSelect.value = 'B4';

                // [NEW] Range Selection Init
                const rangeSection = document.getElementById('print-range-section');
                if (rangeSection) rangeSection.classList.remove('hidden');

                const monthSel = document.getElementById('print-dept-month');
                if (monthSel) {
                    const now = new Date();
                    const viewedDate = this.state.deptViewDate || now;
                    const vY = viewedDate.getFullYear();
                    const vM = viewedDate.getMonth();

                    monthSel.innerHTML = '';
                    for (let m = -2; m <= 6; m++) {
                        // Generate relative to VIEWED DATE, not NOW
                        const d = new Date(vY, vM + m, 1);
                        const opt = document.createElement('option');
                        opt.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                        opt.textContent = `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
                        
                        // Set default to currently viewed month (m=0 is the current view)
                        if (m === 0) {
                            opt.selected = true;
                        }
                        monthSel.appendChild(opt);
                    }
                    
                    // If viewedDate was not in the -2 to +6 range, add it as first option and select it
                    if (monthSel.selectedIndex === -1) {
                        const opt = document.createElement('option');
                        opt.value = `${vY}-${String(vM + 1).padStart(2, '0')}`;
                        opt.textContent = `${vY}년 ${vM + 1}월`;
                        opt.selected = true;
                        monthSel.prepend(opt);
                    }
                    
                    const f2 = document.getElementById('print-dept-front2');
                    const b2 = document.getElementById('print-dept-back2');
                    
                    const updateRange = () => {
                        const [y, m] = monthSel.value.split('-').map(Number);
                        const range = this.calculateDeptPrintRange(y, m, f2.checked, b2.checked);
                        document.getElementById('print-start-date').value = range.start;
                        document.getElementById('print-end-date').value = range.end;
                    };

                    monthSel.onchange = updateRange;
                    f2.onchange = updateRange;
                    b2.onchange = updateRange;

                    // Initial calculation
                    updateRange();
                }
            }
        } catch (e) {
            console.error("Failed to load print modal", e);
            alert('인쇄 설정을 불러올 수 없습니다. (' + e.message + ')');
            return;
        }

        // Bind Events
        document.getElementById('btn-print-close').onclick = () => this.closeModal();
        document.getElementById('btn-print-cancel').onclick = () => this.closeModal();

        document.getElementById('btn-do-print').onclick = () => {
            const size = document.getElementById('print-size').value;
            const orient = document.getElementById('print-orient').value;
            const isScale = document.getElementById('print-scale').checked;
            
            // Fixed: Handle both Radio (checked) and Hidden input types
            const viewInput = document.querySelector('input[name="print-view"]:checked') || document.querySelector('input[name="print-view"]');
            const viewType = viewInput ? viewInput.value : 'calendar';
        
            const customStart = document.getElementById('print-start-date')?.value;
            const customEnd = document.getElementById('print-end-date')?.value;

            this.executePrint(size, orient, isScale, viewType, customStart, customEnd);
        };
    },

    calculateDeptPrintRange: function (year, month, front2, back2) {
        const startOfMonth = new Date(year, month - 1, 1);
        const endOfMonth = new Date(year, month, 0);
        const day15 = new Date(year, month - 1, 15);
        const dayOf15 = day15.getDay(); // 0=Sun...

        const getMonday = (d) => {
            const date = new Date(d);
            const day = date.getDay();
            const diff = date.getDate() - day + (day === 0 ? -6 : 1);
            return new Date(date.setDate(diff));
        };
        const getSunday = (d) => {
            const mon = getMonday(d);
            return new Date(new Date(mon).setDate(mon.getDate() + 6));
        };

        let start, end;

        if (front2 && back2) {
            start = getMonday(startOfMonth);
            end = getSunday(endOfMonth);
        } else if (front2) {
            start = getMonday(startOfMonth);
            if (dayOf15 >= 4 && dayOf15 <= 6) { // Thu, Fri, Sat
                end = getSunday(day15);
            } else { // Sun, Mon, Tue, Wed
                const prevSun = new Date(day15);
                prevSun.setDate(day15.getDate() - dayOf15);
                if (dayOf15 === 0) prevSun.setDate(day15.getDate() - 7);
                end = prevSun;
            }
        } else if (back2) {
            if (dayOf15 >= 4 && dayOf15 <= 6) { // Thu, Fri, Sat
                const nextMon = new Date(getSunday(day15));
                nextMon.setDate(nextMon.getDate() + 1);
                start = nextMon;
            } else { // Sun, Mon, Tue, Wed
                start = getMonday(day15);
            }
            end = getSunday(endOfMonth);
        } else {
            start = startOfMonth;
            end = endOfMonth;
        }

        return {
            start: this.formatLocal(start),
            end: this.formatLocal(end)
        };
    },

    executePrint: async function (size, orient, isScale, viewType, customStart, customEnd) {
        this.closeModal();

        // Store original state if custom range is used
        const originalDate = this.state.deptViewDate;

        // 1. Fetch School Settings for Header (Mainly for Calendar view, but good to have)
        let schoolDisplayName = '';
        try {
            const settings = await this.fetchSettings(this.state.currentYear);
            if (settings) {
                schoolDisplayName = settings.full_name_kr || settings.school_name || settings.name_en || '';
            }
        } catch (e) {
            console.warn("Failed to fetch settings for print header", e);
        }

        // 2. Prepare View
        if (viewType === 'dept_list' && customStart && customEnd) {
            await this.renderDeptListView(customStart, customEnd);
        } else if (viewType === 'weekly_plan' || viewType === 'dept_list') {
            // Just render current month if no custom range but dept_list
            if (viewType === 'dept_list') await this.renderDeptListView();
        } else if (this.state.calendar) {
            if (viewType === 'list') {
                this.state.calendar.changeView('listMonth');
            } else {
                this.state.calendar.changeView('extendedMonth');
            }
        }

        // 3. Inject Print-Only Header (ONLY FOR CALENDAR VIEWS)
        let printHeader = null;
        if (viewType !== 'weekly_plan' && viewType !== 'dept_list') {
            printHeader = document.querySelector('.print-only-header');
            if (!printHeader) {
                printHeader = document.createElement('div');
                printHeader.className = 'print-only-header';
                document.body.prepend(printHeader);
            }

            const calendarTitle = document.querySelector('.fc-toolbar-title')?.textContent || '';
            printHeader.innerHTML = `
                <div class="print-header-left">${calendarTitle}</div>
                <div class="print-header-right">${schoolDisplayName}</div>
            `;
        }

        // 4. Apply Classes to Body
        const body = document.body;
        const previousClasses = body.className;

        body.classList.add('printing-mode');
        body.classList.add(`print-${size.toLowerCase()}`);
        if (isScale) body.classList.add('print-scale');

        // 5. Inject @page Style Dynamically
        const styleId = 'print-page-style';
        let styleEl = document.getElementById(styleId);
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = styleId;
            document.head.appendChild(styleEl);
        }
        // USER REQUEST: margin 10mm
        styleEl.textContent = `@page { size: ${size} ${orient}; margin: 10mm !important; }`;

        // 6. Force Layout for Print: Expand fully without internal scroll
        if (viewType !== 'weekly_plan' && viewType !== 'dept_list' && this.state.calendar) {
            this.state.calendar.setOption('height', 'auto');
            this.state.calendar.setOption('expandRows', false);
            this.state.calendar.updateSize();
        }

        // 7. Print with sufficient delay for reflow
        setTimeout(() => {
            window.print();
        }, 1000);

        const cleanup = async () => {
            body.className = previousClasses;
            if (styleEl) styleEl.remove();
            if (printHeader) printHeader.remove();

            if (viewType === 'dept_list') {
                await this.renderDeptListView(); // Restore original month view
            }

            if (this.state.calendar && viewType !== 'weekly_plan' && viewType !== 'dept_list') {
                this.state.calendar.setOption('height', '100%');
                this.state.calendar.setOption('expandRows', true);
                if (viewType === 'list') {
                    this.state.calendar.changeView(window.innerWidth < 768 ? 'listWeek' : 'extendedMonth');
                }
                this.state.calendar.updateSize();
                this.distributeVerticalSpace(); // Recalculate if needed
            }
            window.removeEventListener('afterprint', cleanup);
        };

        window.addEventListener('afterprint', cleanup);
    },

    // --- Excel Upload Logic ---

    openExcelModal: async function () {
        const modalContainer = document.getElementById('modal-container');
        try {
            if (!this.state.templates['excel']) {
                const response = await fetch('pages/modal-excel.html');
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                this.state.templates['excel'] = await response.text();
            }
            modalContainer.innerHTML = this.state.templates['excel'];
            modalContainer.classList.remove('invisible');
        } catch (e) {
            console.error("Failed to load excel modal", e);
            alert('엑셀 업로드 창을 불러올 수 없습니다. (' + e.message + ')');
            return;
        }

        // Bind Elements
        const fileInput = document.getElementById('excel-file-input');
        const fileNameDisplay = document.getElementById('excel-file-name');
        const btnUpload = document.getElementById('btn-upload-submit');
        const statusArea = document.getElementById('upload-status-area');
        const previewCount = document.getElementById('preview-count');
        const errorList = document.getElementById('preview-error-list');
        const yearSelect = document.getElementById('excel-year-select');

        let parsedBasic = [];
        let parsedNormal = [];
        let excelCount = 0;
        let yearDepartments = [];

        // Function to refresh departments for selected year
        const refreshYearDepts = async () => {
            const selectedYear = parseInt(yearSelect.value);
            yearDepartments = await this.fetchDepartments(selectedYear);
            console.log(`Loaded ${yearDepartments.length} departments for year ${selectedYear}`);
        };

        // Initial fetch
        await refreshYearDepts();

        // Populate Year Options
        const currentYear = this.state.currentYear || new Date().getFullYear();
        yearSelect.innerHTML = '';
        const years = [];
        for (let i = -5; i <= 5; i++) {
            years.push(currentYear + i);
        }
        years.forEach(y => {
            const opt = document.createElement('option');
            opt.value = y;
            opt.text = `${y}학년도`;
            if (y === currentYear) opt.selected = true;
            yearSelect.appendChild(opt);
        });

        // Close handlers
        const close = () => {
            modalContainer.classList.add('invisible');
            modalContainer.innerHTML = '';
        };
        document.getElementById('btn-excel-close').onclick = close;
        document.getElementById('btn-excel-cancel').onclick = close;

        // Template Download
        document.getElementById('btn-download-template').onclick = () => {
            const wb = XLSX.utils.book_new();
            const ws_data = [
                ['구분(기본/휴일/일반)', '부서명(일반인 경우)', '일정명', '시작일(YYYY-MM-DD)', '종료일(YYYY-MM-DD)', '내용', '공개범위(전체/교직원/부서)', '주말포함(on)'],
                // 학기/방학 행사
                ['기본', '', '여름방학', '2026-07-22', '2026-08-12', '', '전체'],
                ['기본', '', '겨울방학', '2026-01-07', '', '', '전체'],
                ['기본', '', '봄방학', '', '', '', '전체'],

                // 고사 일정 (범위)
                ['기본', '', '1학기 1차지필', '2026-04-24', '2026-04-29', '', '전체'],
                ['기본', '', '1학기 2차지필', '2026-06-30', '2026-07-06', '', '전체'],
                ['기본', '', '2학기 1차지필', '2026-09-30', '2026-10-06', '', '전체'],
                ['기본', '', '2학기 2차지필', '2026-12-10', '2026-12-16', '', '전체'],
                ['기본', '', '3학년 2학기 2차지필', '', '', '', '전체'],

                // 예시
                ['휴일', '', '대체공휴일', '2026-05-06', '2026-05-06', '', '전체'],
                ['일반', '교무기획부', '학부모총회', '2026-03-15', '2026-03-16', '강당', '전체']
            ];
            const ws = XLSX.utils.aoa_to_sheet(ws_data);
            XLSX.utils.book_append_sheet(wb, ws, '일정양식');
            XLSX.writeFile(wb, "학사일정_일괄등록_양식.xlsx");
        };

        // File Select & Parse
        fileInput.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;

            fileNameDisplay.textContent = file.name;

            // Read selected year when file changes (or ensure we read it on submit, but preview uses it for display if needed? 
            // Actually preview currently builds parsed data with year. So we must capture year here.)
            const selectedYear = parseInt(yearSelect.value);

            const reader = new FileReader();
            reader.onload = (evt) => {
                const data = new Uint8Array(evt.target.result);
                // cellDates: true ensures dates come as JS Date objects, not serial numbers
                const workbook = XLSX.read(data, { type: 'array', cellDates: true });
                const firstSheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[firstSheetName];

                // Convert to JSON
                const rawRows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
                // Remove header row
                if (rawRows.length > 0) rawRows.shift();

                if (rawRows.length === 0) {
                    alert('엑셀 파일에 데이터가 없습니다.');
                    return;
                }

                // Auto-Mapping Definition
                const titleMap = {
                    '1학기 개학일': { code: 'TERM1_START', type: 'term' },
                    '여름방학식': { code: 'SUMMER_VAC_CEREMONY', type: 'event' },
                    '여름방학': { code: 'SUMMER_VAC', type: 'vacation' }, // Range
                    '여름방학 기간': { code: 'SUMMER_VAC', type: 'vacation' },
                    '2학기 개학일': { code: 'TERM2_START', type: 'term' },
                    '겨울방학식': { code: 'WINTER_VAC_CEREMONY', type: 'event' },
                    '겨울방학': { code: 'WINTER_VAC', type: 'vacation' }, // Range
                    '겨울방학 기간': { code: 'WINTER_VAC', type: 'vacation' },
                    '봄 개학일': { code: 'SPRING_SEM_START', type: 'term' },
                    '봄방학식': { code: 'SPRING_VAC_CEREMONY', type: 'event' },
                    '봄방학': { code: 'SPRING_VAC', type: 'vacation' }, // Range
                    '봄방학 기간': { code: 'SPRING_VAC', type: 'vacation' },

                    // Exams (Range)
                    '1학기 1차지필': { code: 'EXAM_1_1', type: 'exam' },
                    '1학기 2차지필': { code: 'EXAM_1_2', type: 'exam' },
                    '2학기 1차지필': { code: 'EXAM_2_1', type: 'exam' },
                    '2학기 2차지필': { code: 'EXAM_2_2', type: 'exam' },
                    '3학년 2학기 2차지필': { code: 'EXAM_3_2_2', type: 'exam' }
                };

                const depts = yearDepartments;
                parsedBasic = [];
                parsedNormal = [];
                let errors = [];

                // Use the year selected in dropdown
                const year = selectedYear;

                excelCount = 0;
                rawRows.forEach((row, idx) => {
                    // Check for completely empty row
                    if (!row || row.length === 0) return;

                    // Columns: 0:Type, 1:Dept, 2:Title, 3:Start, 4:End, 5:Desc, 6:Vis
                    const typeRaw = (row[0] || '').toString().trim();
                    const deptName = (row[1] || '').toString().trim();
                    const title = (row[2] || '').toString().trim();
                    // Parse Dates: Handle JS Date object (from cellDates: true) or String
                    const parseDate = (v) => {
                        if (!v) return '';
                        if (v instanceof Date) {
                            const y = v.getFullYear();
                            const m = String(v.getMonth() + 1).padStart(2, '0');
                            const d = String(v.getDate()).padStart(2, '0');
                            return `${y}-${m}-${d}`;
                        }
                        return v.toString().trim();
                    };

                    let start = parseDate(row[3]);
                    let end = parseDate(row[4]);
                    const desc = (row[5] || '').toString().trim();
                    const visibilityRaw = (row[6] || '').toString().trim();
                    const weekendRaw = (row[7] || '').toString().trim().toLowerCase(); // Column index 7

                    if (!title || !start) {
                        // Only skip if completely empty
                        if (!typeRaw && !title && !start) return;

                        // Skip optional events if start date is missing without error
                        // Using .includes for better matching
                        if (title && !start && (title.includes('봄방학') || title.includes('2차지필'))) {
                            return;
                        }

                        errors.push(`${idx + 2}행: 필수 정보 누락 (일정명, 시작일)`);
                        return;
                    }

                    if (typeRaw === '기본' || typeRaw === '휴일') {
                        // Check Auto-Mapping
                        const mapInfo = titleMap[title];

                        if (mapInfo) {
                            // System Code Item
                            parsedBasic.push({
                                academic_year: year,
                                type: mapInfo.type,
                                code: mapInfo.code,
                                name: title,
                                start_date: start,
                                end_date: end || start, // Use merged date from row
                                is_holiday: false
                            });
                        } else {
                            // Standard Basic Event (No Code)
                            parsedBasic.push({
                                academic_year: year,
                                type: typeRaw === '휴일' ? 'holiday' : 'event',
                                code: null,
                                name: title,
                                start_date: start,
                                end_date: end || start,
                                is_holiday: typeRaw === '휴일'
                            });
                        }
                        excelCount++;
                    } else if (typeRaw === '일반') {
                        // Match Dept by Name (NFC normalizable)
                        const normalize = (s) => (s || '').normalize('NFC').replace(/\s+/g, '');
                        const targetNorm = normalize(deptName);

                        const dept = depts.find(d => normalize(d.dept_name) === targetNorm);

                        if (deptName && !dept) {
                            errors.push(`${idx + 2}행: 부서명 오류 ('${deptName}'은(는) ${selectedYear}학년도에 존재하지 않습니다.)`);
                        }

                        // Use found dept or fallback to first one if name was provided but not found
                        const finalDept = dept || depts[0] || { id: null };

                        // Map Visibility
                        let visibility = 'internal';
                        if (visibilityRaw === '전체') visibility = 'public';
                        else if (visibilityRaw === '부서') visibility = 'dept';

                        parsedNormal.push({
                            title,
                            start_date: start,
                            end_date: end || start,
                            description: desc || '',
                            dept_id: finalDept.id,
                            dept_name: deptName, // Store raw name for recovery
                            visibility,
                            author_id: this.state.user.id,
                            is_printable: true,
                            weekend: weekendRaw === 'on' ? 'on' : null
                        });
                        excelCount++;
                    } else {
                        errors.push(`${idx + 2}행: 구분 값 오류 ('기본', '휴일', 또는 '일반' 입력)`);
                    }
                });

                // --- Auto-Calculation Logic (Holiday Aware) ---

                // Helper: Check if a date is a school day and not a holiday
                const isSchoolDay = (d) => {
                    const day = d.getDay();
                    if (day === 0 || day === 6) return false; // Weekend

                    const dStr = d.toISOString().split('T')[0];
                    // Check Parsed Holidays (Basic & Holiday type)
                    const isParsedHoliday = parsedBasic.some(p => p.is_holiday && p.start_date <= dStr && p.end_date >= dStr);
                    if (isParsedHoliday) return false;

                    return true;
                };

                const findPrevSchoolDay = (startDateStr) => {
                    let d = new Date(startDateStr);
                    d.setDate(d.getDate() - 1); // Start from day before
                    let safety = 0;
                    while (safety < 30) {
                        if (isSchoolDay(d)) return d.toISOString().split('T')[0];
                        d.setDate(d.getDate() - 1);
                        safety++;
                    }
                    return startDateStr; // Fallback
                };

                const findNextSchoolDay = (endDateStr) => {
                    let d = new Date(endDateStr);
                    d.setDate(d.getDate() + 1); // Start from day after
                    let safety = 0;
                    while (safety < 30) {
                        if (isSchoolDay(d)) return d.toISOString().split('T')[0];
                        d.setDate(d.getDate() + 1);
                        safety++;
                    }
                    return endDateStr; // Fallback
                };

                // Helper to find if code exists
                const hasCode = (code) => parsedBasic.some(p => p.code === code);
                const getCodeItem = (code) => parsedBasic.find(p => p.code === code);

                // 2. Summer Vac Ceremony (If missing, detected by VAC start)
                const summerVac = getCodeItem('SUMMER_VAC');
                if (summerVac && !hasCode('SUMMER_VAC_CEREMONY')) {
                    const ceremonyDate = findPrevSchoolDay(summerVac.start_date);
                    parsedBasic.push({
                        academic_year: year,
                        type: 'event',
                        code: 'SUMMER_VAC_CEREMONY',
                        name: '여름방학식',
                        start_date: ceremonyDate,
                        end_date: ceremonyDate,
                        is_holiday: false
                    });
                }

                // 3. Term 2 Start (If missing, detected by VAC end)
                if (summerVac && !hasCode('TERM2_START')) {
                    const term2Start = findNextSchoolDay(summerVac.end_date);
                    parsedBasic.push({
                        academic_year: year,
                        type: 'term',
                        code: 'TERM2_START',
                        name: '2학기 개학일',
                        start_date: term2Start,
                        end_date: term2Start,
                        is_holiday: false
                    });
                }

                // 4. Winter Vac Ceremony (If missing, detected by Winter start)
                const winterVac = getCodeItem('WINTER_VAC');
                if (winterVac && !hasCode('WINTER_VAC_CEREMONY')) {
                    const ceremonyDate = findPrevSchoolDay(winterVac.start_date);
                    parsedBasic.push({
                        academic_year: year,
                        type: 'event',
                        code: 'WINTER_VAC_CEREMONY',
                        name: '겨울방학식',
                        start_date: ceremonyDate,
                        end_date: ceremonyDate,
                        is_holiday: false
                    });
                }

                // 5. Spring Sem Start (If missing, detected by Winter end)
                if (winterVac && !hasCode('SPRING_SEM_START')) {
                    const nextSchoolDay = findNextSchoolDay(winterVac.end_date);
                    const nDate = this.parseLocal(nextSchoolDay);
                    if (nDate.getMonth() !== 2) {
                        parsedBasic.push({
                            academic_year: year,
                            type: 'term',
                            code: 'SPRING_SEM_START',
                            name: '봄 개학일',
                            start_date: nextSchoolDay,
                            end_date: nextSchoolDay,
                            is_holiday: false
                        });
                    }
                }

                // 6. Spring Vac Ceremony (If missing, detected by Spring Vac start)
                const springVac = getCodeItem('SPRING_VAC');
                if (springVac && !hasCode('SPRING_VAC_CEREMONY')) {
                    const ceremonyDate = findPrevSchoolDay(springVac.start_date);
                    parsedBasic.push({
                        academic_year: year,
                        type: 'event',
                        code: 'SPRING_VAC_CEREMONY',
                        name: '봄방학식',
                        start_date: ceremonyDate,
                        end_date: ceremonyDate,
                        is_holiday: false
                    });
                }
                // --- Auto-Calculation Logic End ---
                statusArea.classList.remove('hidden');

                // Show errors if any (Simple alert or list)
                if (errors.length > 0) {
                    alert('일부 데이터 오류:\n' + errors.slice(0, 5).join('\n') + (errors.length > 5 ? '\n...' : ''));
                }

                if (excelCount > 0) {
                    statusArea.innerHTML = `<span class="text-green-600 font-bold">총 ${excelCount}건의 일정 발견</span>`;
                    btnUpload.disabled = false;
                    btnUpload.classList.remove('opacity-50', 'cursor-not-allowed');
                } else {
                    let debugMsg = '총 0건의 일정이 발견되었습니다.\n';
                    if (rawRows && rawRows.length > 0) {
                        const firstRow = rawRows[0];
                        const rowData = firstRow.map((v, i) => `[${i}] ${v}`).join(', ');
                        debugMsg += `\n[디버깅 정보]\n`;
                        debugMsg += `첫 행 데이터 길이: ${firstRow.length}\n`;
                        debugMsg += `데이터 내용: ${rowData}\n`;
                        debugMsg += `\n[매핑 시도]\n`;
                        debugMsg += `구분(Col 0): "${(firstRow[0] || '').toString().trim()}"\n`;
                        debugMsg += `제목(Col 2): "${(firstRow[2] || '').toString().trim()}"\n`;
                        if (errors.length > 0) {
                            debugMsg += `\n[오류 메시지(3건)]\n${errors.slice(0, 3).join('\n')}`;
                        }
                    } else {
                        debugMsg += '데이터 행이 비어있습니다.';
                    }
                    statusArea.innerHTML = `<span class="text-red-500 font-bold">발견된 일정이 없습니다.</span>`;
                    alert(debugMsg);
                }
            };
            reader.readAsArrayBuffer(file);
        };

        yearSelect.onchange = async () => {
            await refreshYearDepts();
            if (fileInput.files.length > 0) {
                fileInput.dispatchEvent(new Event('change'));
            }
        };

        // Upload Action
        btnUpload.onclick = async () => {
            const selectedYear = yearSelect.value;
            if (parsedBasic.length === 0 && parsedNormal.length === 0) return;

            const total = parsedBasic.length + parsedNormal.length;
            const autoCount = total - excelCount;

            let confirmMsg = `${selectedYear}학년도 학사일정 ${excelCount}건을 등록하시겠습니까?`;
            if (autoCount > 0) {
                confirmMsg += `\n\n(방학식, 개학일 등 ${autoCount}건의 일정이 자동으로 추가 생성됩니다. 총 ${total}건)`;
            }

            if (!confirm(confirmMsg)) return;

            btnUpload.disabled = true;
            btnUpload.textContent = '업로드 중...';

            try {
                if (parsedBasic.length > 0) {
                    const { error: err1 } = await window.SupabaseClient.supabase
                        .from('basic_schedules')
                        .insert(parsedBasic);
                    if (err1) throw err1;
                }

                if (parsedNormal.length > 0) {
                    const { error: err2 } = await window.SupabaseClient.supabase
                        .from('schedules')
                        .insert(parsedNormal);
                    if (err2) throw err2;
                }

                this.logAction('BULK_INSERT', 'mixed', null, { basic: parsedBasic.length, normal: parsedNormal.length });
                alert(`총 ${parsedBasic.length + parsedNormal.length}건의 일정이 등록되었습니다.`);
                close();

                // Auto-refresh Admin View if available
                if (this.refreshAdminView) {
                    await this.refreshAdminView(parseInt(selectedYear));
                }

                if (this.state.calendar) this.initCalendar();

            } catch (e) {
                console.error(e);
                alert('업로드 실패: ' + e.message);
                btnUpload.disabled = false;
                btnUpload.textContent = '업로드';
            }
        };
    },

    openDeptImportModal: async function () {
        const modalContainer = document.getElementById('modal-container');
        try {
            if (!this.state.templates['dept-import']) {
                const response = await fetch('pages/modal-dept-import.html');
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                this.state.templates['dept-import'] = await response.text();
            }
            modalContainer.innerHTML = this.state.templates['dept-import'];
            modalContainer.classList.remove('invisible');
        } catch (e) {
            console.error("Failed to load dept import modal", e);
            alert('모달을 불러올 수 없습니다. (' + e.message + ')');
            return;
        }

        const btnClose = document.getElementById('btn-dept-import-close');
        const btnCancel = document.getElementById('btn-dept-import-cancel');
        const btnSubmit = document.getElementById('btn-dept-import-submit');
        const fromYearSelect = document.getElementById('import-from-year');
        const toYearSelect = document.getElementById('import-to-year');
        const statusArea = document.getElementById('import-status');

        const closeModal = () => {
            modalContainer.innerHTML = '';
            modalContainer.classList.add('invisible');
        };
        if (btnClose) btnClose.onclick = closeModal;
        if (btnCancel) btnCancel.onclick = closeModal;

        // Populate Years
        const currentYear = new Date().getFullYear();
        for (let y = currentYear - 5; y <= currentYear + 5; y++) {
            const optF = document.createElement('option');
            optF.value = y;
            optF.textContent = `${y}학년도`;
            if (y === currentYear - 1) optF.selected = true;
            fromYearSelect.appendChild(optF);

            const optT = document.createElement('option');
            optT.value = y;
            optT.textContent = `${y}학년도`;
            if (y === currentYear) optT.selected = true;
            toYearSelect.appendChild(optT);
        }

        if (btnSubmit) {
            btnSubmit.onclick = async () => {
                const fy = parseInt(fromYearSelect.value);
                const ty = parseInt(toYearSelect.value);

                if (fy === ty) {
                    alert('가져올 년도와 대상 년도가 같습니다.');
                    return;
                }

                if (!confirm(`${fy}학년도 부서 정보를 ${ty}학년도로 가져오시겠습니까?\n\n※ 이미 등록된 부서는 정보가 업데이트되고, 없는 부서는 새로 추가됩니다.`)) return;

                btnSubmit.disabled = true;
                btnSubmit.innerHTML = '가져오는 중...';

                try {
                    const result = await this.handleDeptImport(fy, ty);
                    if (result.success) {
                        alert(`부서 정보를 성공적으로 가져왔습니다. (데이터: ${result.count}건)`);
                        // Refresh current view if target year matches
                        const currentAdminYear = parseInt(document.getElementById('setting-academic-year')?.value);
                        if (currentAdminYear === ty) {
                            if (this.refreshAdminView) this.refreshAdminView(ty);
                        }
                        closeModal();
                    } else {
                        throw new Error(result.error || '알 수 없는 오류');
                    }
                } catch (err) {
                    console.error("Import failed", err);
                    statusArea.textContent = '가져오기 실패: ' + err.message;
                    statusArea.classList.remove('hidden');
                    btnSubmit.disabled = false;
                    btnSubmit.innerHTML = '<span class="material-symbols-outlined text-sm">check_circle</span> 확인';
                }
            };
        }
    },

    handleDeptImport: async function (fromYear, toYear) {
        try {
            // 1. Fetch Source
            const { data: sourceDepts, error: fetchErr } = await window.SupabaseClient.supabase
                .from('departments')
                .select('*')
                .eq('academic_year', fromYear);

            if (fetchErr) throw fetchErr;
            if (!sourceDepts || sourceDepts.length === 0) {
                throw new Error(`${fromYear}학년도에는 등록된 부서 정보가 없습니다.`);
            }

            // 2. Fetch Target (to check for existing IDs/names)
            const { data: targetDepts, error: targetErr } = await window.SupabaseClient.supabase
                .from('departments')
                .select('id, dept_name')
                .eq('academic_year', toYear);

            if (targetErr) throw targetErr;

            // Map target depts by name for quick lookup
            const targetMap = (targetDepts || []).reduce((acc, d) => {
                acc[d.dept_name] = d.id;
                return acc;
            }, {});

            // 3. Prep Payloads (Strict Separation)
            const toUpdate = [];
            const toInsert = [];

            sourceDepts.forEach(d => {
                const row = {
                    academic_year: toYear,
                    dept_name: d.dept_name,
                    dept_short: d.dept_short,
                    dept_color: d.dept_color,
                    sort_order: d.sort_order,
                    is_active: d.is_active,
                    is_printable: d.is_printable !== undefined ? d.is_printable : true
                };

                // Check if it exists ONLY in the target year
                if (targetMap[d.dept_name]) {
                    // Use target's existing ID to perform an update
                    // NEVER use d.id (from source year)
                    row.id = targetMap[d.dept_name];
                    toUpdate.push(row);
                } else {
                    // No match in target -> Fresh INSERT
                    toInsert.push(row);
                }
            });

            // 4. Execute (Strictly separate to prevent cross-year ID pollution)
            if (toUpdate.length > 0) {
                const { error: updErr } = await window.SupabaseClient.supabase
                    .from('departments')
                    .upsert(toUpdate, { onConflict: 'id' });
                if (updErr) throw updErr;
            }

            if (toInsert.length > 0) {
                const { error: insErr } = await window.SupabaseClient.supabase
                    .from('departments')
                    .insert(toInsert);
                if (insErr) throw insErr;
            }

            return { success: true, count: sourceDepts.length };
        } catch (e) {
            return { success: false, error: e.message };
        }
    },


    bindCalendarSearch: function () {
        const searchInput = document.getElementById('search-schedule');
        const searchResults = document.getElementById('search-results');
        if (!searchInput) return;

        searchInput.addEventListener('input', (e) => {
            const query = e.target.value.toLowerCase().trim();
            if (query.length < 2) {
                searchResults.classList.add('hidden');
                return;
            }

            const matches = (this.state.schedules || []).filter(s =>
                s.title.toLowerCase().includes(query) ||
                (s.description && s.description.toLowerCase().includes(query))
            );

            searchResults.classList.remove('hidden');
            if (matches.length === 0) {
                searchResults.innerHTML = `<div class="text-gray-400 p-2 text-xs">검색 결과가 없습니다.</div>`;
            } else {
                searchResults.innerHTML = matches.map(s => `
                    <div class="cursor-pointer hover:bg-purple-50 p-2 rounded truncate border-b last:border-0" data-date="${s.start_date}" data-id="${s.id}">
                        <div class="font-bold text-gray-700 text-xs">${s.title}</div>
                        <div class="text-xs text-gray-500">${s.start_date}</div>
                    </div>
                `).join('');

                searchResults.querySelectorAll('div[data-date]').forEach(el => {
                    el.onclick = () => {
                        this.state.calendar.gotoDate(el.dataset.date);
                        searchResults.classList.add('hidden');
                        searchInput.value = '';
                    };
                });
            }
        });

        document.addEventListener('click', (e) => {
            if (!searchInput.contains(e.target) && !searchResults.contains(e.target)) {
                searchResults.classList.add('hidden');
            }
        });
    },

    refreshCalendarData: async function (start, end) {
        const startY = start.getFullYear();
        const endY = end.getFullYear();
        const academicYears = [];
        for (let cy = startY - 1; cy <= endY; cy++) {
            academicYears.push(cy);
        }

        const [basicRows, departmentsRes, schedules] = await Promise.all([
            window.SupabaseClient.supabase.from('basic_schedules').select('*').in('academic_year', academicYears),
            window.SupabaseClient.supabase.from('departments').select('*').in('academic_year', academicYears), // Get all for robust lookup
            this.fetchSchedules()
        ]);

        const allDepartments = departmentsRes.data || [];
        const activeDepartments = allDepartments.filter(d => d.is_active);

        this.state.departments = activeDepartments; // For sidebar filter list
        this.state.schedules = schedules;

        const data = {
            holidayMap: {},
            redDayMap: {},
            bgColorMap: {}, // ADDED: To store background color for header only
            scheduleMap: {},
            backgroundEvents: [],
            departments: allDepartments // For calendar cell lookup (includes inactive/historical)
        };

        const allEvents = this.transformEvents(schedules, {}, allDepartments, basicRows.data || []);

        allEvents.forEach(e => {
            const dateKey = e.start;
            if (e.display === 'background' || e.display === 'block') {
                if (e.display === 'background') data.backgroundEvents.push(e);

                if (e.className.includes('holiday-bg-event') || e.className.includes('event-major-text') || e.className.includes('event-env-text') || e.className.includes('event-exam-text') || e.className.includes('event-term-text')) {
                    if (!data.holidayMap[dateKey]) data.holidayMap[dateKey] = [];
                    const label = e.extendedProps?.label || e.title;
                    if (label && !data.holidayMap[dateKey].includes(label)) data.holidayMap[dateKey].push(label);
                    if (e.className.includes('holiday-bg-event')) {
                        data.redDayMap[dateKey] = true;
                        data.bgColorMap[dateKey] = '#fef2f2'; // Holiday Red
                    } else if (e.className.includes('vacation-bg-event')) {
                        data.bgColorMap[dateKey] = '#fffcfc'; // Vacation Pink
                    } else if (e.className.includes('event-exam-text')) {
                        data.bgColorMap[dateKey] = '#fff7ed'; // Exam Orange
                    } else if (e.className.includes('event-major-text')) {
                        data.bgColorMap[dateKey] = '#eff6ff'; // Event Blue
                    }
                }

                // Also check vacation events if not caught above (though vacation usually doesn't have text classes, but let's be safe)
                if (e.className.includes('vacation-bg-event')) {
                    data.bgColorMap[dateKey] = '#fffcfc';
                }
            } else {
                let current = this.parseLocal(e.start);
                const endEv = e.end ? this.parseLocal(e.end) : this.parseLocal(e.start);
                let daysCount = 0;
                while (current <= endEv) {
                    if (daysCount > 365) break;
                    const dKey = this.formatLocal(current);

                    // --- Weekend/Holiday Visibility Check ---
                    const day = current.getDay();
                    const isWeekend = day === 0 || day === 6;
                    const isHoliday = data.redDayMap && data.redDayMap[dKey];
                    const showOnWeekend = e.extendedProps?.weekend === 'on';

                    // If it's a holiday/weekend AND not explicitly 'showOnWeekend', skip rendering this day
                    if ((isWeekend || isHoliday) && !showOnWeekend) {
                        // Special case: If it's a single-day entry (start === end) and the user explicitly clicked it, we show it (standard FC behavior)
                        // But range entries (startDate !== endDate) should respect the rule.
                        const isRangeEntry = e.start !== (e.end || e.start);
                        if (isRangeEntry) {
                            current.setDate(current.getDate() + 1);
                            daysCount++;
                            continue;
                        }
                    }

                    if (!data.scheduleMap[dKey]) data.scheduleMap[dKey] = {};
                    const deptId = (e.extendedProps && e.extendedProps.deptId) || 'uncategorized';
                    if (!data.scheduleMap[dKey][deptId]) {
                        const deptInfo = (e.extendedProps && e.extendedProps.deptInfo) || { dept_name: '기타', dept_color: '#333' };
                        data.scheduleMap[dKey][deptId] = { info: deptInfo, events: [] };
                    }
                    data.scheduleMap[dKey][deptId].events.push(e);
                    current.setDate(current.getDate() + 1);
                    if (!e.end) break;
                    daysCount++;
                }
            }
        });

        this.state.calendarData = data;
        this.state.calendar.setOption('events', data.backgroundEvents);

        // Force full rerender of the calendar to apply classes and cell content immediately
        this.state.calendar.render();
    },

    renderCalendarCell: function (arg) {
        const dateStr = this.formatLocal(arg.date);
        const data = this.state.calendarData || { holidayMap: {}, redDayMap: {}, scheduleMap: {}, departments: [] };

        const container = document.createElement('div');
        container.className = "flex flex-col w-full justify-start items-stretch"; // Removed flex-grow
        container.style.height = "100%"; // RESTORED: Force full height for sticky header track

        // MASKING: Ensure the whole cell is opaque white (or today color) to hide FullCalendar background events
        // This reinforces the "color restricted to header" rule.
        if (arg.isToday) {
            container.style.backgroundColor = 'var(--fc-today-bg-color)';
        } else {
            container.style.backgroundColor = '#ffffff';
        }

        // Group header and divider to apply background color up to the divider line
        const headerGroup = document.createElement('div');
        headerGroup.className = 'calendar-cell-header'; // For triangle styling
        headerGroup.style.width = '100%';
        headerGroup.style.display = 'flex';
        headerGroup.style.flexDirection = 'column';

        // STICKY: Make the header stay at the top during scroll
        headerGroup.style.position = 'sticky';
        headerGroup.style.top = '0';
        headerGroup.style.zIndex = '10';

        // Ensure a solid background even if not a holiday, so schedule text hides behind it
        let cellBgColor = '#ffffff';
        if (arg.isOther) {
            cellBgColor = '#ffffff'; // White for non-current month days (no background)
        } else if (data.bgColorMap && data.bgColorMap[dateStr]) {
            cellBgColor = data.bgColorMap[dateStr];
        }

        headerGroup.style.backgroundColor = cellBgColor;

        headerGroup.style.paddingTop = '4px'; // COVERAGE: Padding is part of the colored area
        // Separation from content below, OUTSIDE the colored area
        headerGroup.style.marginBottom = '5px';

        const headerRow = document.createElement('div');
        headerRow.style.display = 'grid';
        headerRow.style.gridTemplateColumns = '42px minmax(0, 1fr)';
        headerRow.style.alignItems = 'baseline';
        headerRow.style.width = '100%';
        headerRow.style.marginBottom = '2px';

        // Background applied to headerGroup now


        // 1. Day Number (Left) - Wrapped
        const dateWrapper = document.createElement('div');
        dateWrapper.className = 'fc-daygrid-date-wrapper';

        const dayLink = document.createElement('a');
        dayLink.className = "fc-daygrid-day-number";
        dayLink.style.whiteSpace = 'nowrap';
        dayLink.style.textAlign = 'left';
        dayLink.style.paddingLeft = '4px';
        dayLink.style.textDecoration = 'none';
        // Add three spaces before the day number as requested
        // USER REQUEST: Always display only the day (e.g. "1일"), never the month (e.g. "1월 1일")
        dayLink.textContent = '\u00A0\u00A0\u00A0' + arg.date.getDate() + '일';

        dateWrapper.appendChild(dayLink);
        headerRow.appendChild(dateWrapper);

        // 2. Holiday Names (Right)
        if (data.holidayMap[dateStr] || arg.isToday) {
            const nameContainer = document.createElement('div');
            nameContainer.className = 'fc-daygrid-holiday-wrapper'; // Add separate class
            nameContainer.style.overflow = 'hidden';
            nameContainer.style.textAlign = 'left';
            nameContainer.style.lineHeight = '1.2';
            nameContainer.style.paddingTop = '1px';
            nameContainer.style.marginRight = '4px';

            // Add (오늘) Label
            if (arg.isToday) {
                const todaySpan = document.createElement('span');
                todaySpan.style.display = 'inline-block';
                todaySpan.style.fontSize = '10px';
                todaySpan.style.fontWeight = 'bold';
                todaySpan.style.color = '#2563eb'; // Blue-600
                todaySpan.style.marginRight = '4px';
                todaySpan.textContent = '(오늘)';
                nameContainer.appendChild(todaySpan);
            }

            if (data.holidayMap[dateStr]) {
                data.holidayMap[dateStr].forEach((name, index) => {
                    const itemSpan = document.createElement('span');
                    itemSpan.style.display = 'inline-block';
                    itemSpan.style.fontSize = '10px';
                    itemSpan.style.wordBreak = 'keep-all';
                    itemSpan.style.position = 'relative';
                    if (index > 0) itemSpan.style.marginLeft = '4px';

                    itemSpan.className = "holiday-name";
                    itemSpan.textContent = name;

                    if (index < data.holidayMap[dateStr].length - 1) {
                        const commaSpan = document.createElement('span');
                        commaSpan.textContent = ',';
                        commaSpan.style.position = 'absolute';
                        commaSpan.style.right = '-4px';
                        commaSpan.style.top = '0';
                        itemSpan.appendChild(commaSpan);
                    }
                    nameContainer.appendChild(itemSpan);
                });
                nameContainer.title = data.holidayMap[dateStr].join(', ');
            }
            headerRow.appendChild(nameContainer);
        } else {
            headerRow.appendChild(document.createElement('div'));
        }

        headerGroup.appendChild(headerRow);

        // 3. Add Dashed Divider (Always visible in all views)
        const divider = document.createElement('div');
        divider.className = 'calendar-dashed-divider';
        divider.style.margin = '1px 8px 0px 8px'; // Bottom margin is 0 here to keep color inside
        divider.style.borderTop = '1px dashed #d1d5db'; // gray-300
        headerGroup.appendChild(divider);

        container.appendChild(headerGroup);

        if (data.scheduleMap[dateStr]) {
            const groups = data.scheduleMap[dateStr];
            const sortedDeptIds = Object.keys(groups).sort((a, b) => {
                const idxA = (data.departments || []).findIndex(d => d.id == a);
                const idxB = (data.departments || []).findIndex(d => d.id == b);
                return idxA - idxB;
            });

            sortedDeptIds.forEach((deptId, idx) => {
                const group = groups[deptId];
                const hasPrintableInDept = group.events.some(ev => ev.extendedProps.isPrintable !== false);

                // Add spacer between different departments
                if (idx > 0) {
                    const spacer = document.createElement('div');
                    spacer.style.height = '12px';
                    // Hide spacer if the following department has no printable content
                    if (!hasPrintableInDept) spacer.classList.add('no-print');
                    container.appendChild(spacer);
                }

                const deptDiv = document.createElement('div');
                deptDiv.className = "w-full text-left mb-1 pl-1";
                deptDiv.style.fontSize = '10px';
                if (!hasPrintableInDept) deptDiv.classList.add('no-print');

                const deptHeader = document.createElement('div');
                deptHeader.className = "dept-header font-bold mb-0.5 whitespace-nowrap overflow-hidden text-ellipsis";
                deptHeader.style.color = '#000';
                // Displaying `◈ [dept_short]` format
                const deptShort = group.info.dept_short || group.info.dept_name.substring(0, 2);
                deptHeader.innerHTML = `<span style="color:${group.info.dept_color}">◈</span> ${deptShort}`;
                deptDiv.appendChild(deptHeader);

                group.events.forEach(ev => {
                    const evDiv = document.createElement('div');
                    evDiv.className = "schedule-item cursor-pointer hover:bg-gray-100 rounded px-1 py-0.5 break-words flex items-start leading-tight";
                    evDiv.style.fontSize = '10px';
                    evDiv.style.color = '#374151'; // Explicitly set dark grey color

                    // Hide non-printable event during printing
                    if (ev.extendedProps.isPrintable === false) {
                        evDiv.classList.add('no-print');
                    }

                    const canEdit = this.state.role === 'admin' || this.state.role === 'head_teacher' || this.state.role === 'head';

                    if (canEdit) {
                        const checkbox = document.createElement('input');
                        checkbox.type = 'checkbox';
                        checkbox.className = 'no-print mt-0.5 mr-1 h-3 w-3 rounded border-gray-300 text-blue-600 focus:ring-blue-500 flex-shrink-0';
                        checkbox.checked = ev.extendedProps.isPrintable !== false;

                        checkbox.onclick = async (e) => {
                            e.stopPropagation();
                            const newValue = e.target.checked;

                            // Optimistic update
                            ev.extendedProps.isPrintable = newValue;

                            // DB Update (Fire & Forget style for speed, validation via Supabase usually reliable)
                            await window.SupabaseClient.supabase
                                .from('schedules')
                                .update({ is_printable: newValue })
                                .eq('id', ev.id);
                        };

                        evDiv.appendChild(checkbox);
                    }

                    const textSpan = document.createElement('span');
                    const titleText = (ev.extendedProps && ev.extendedProps.description)
                        ? `· ${ev.title}(${ev.extendedProps.description})`
                        : `· ${ev.title}`;
                    textSpan.textContent = titleText;
                    evDiv.appendChild(textSpan);

                    evDiv.title = titleText;
                    evDiv.onclick = (e) => {
                        e.stopPropagation();
                        this.openScheduleModal(ev.id);
                    };
                    deptDiv.appendChild(evDiv);
                });
                container.appendChild(deptDiv);
            });
        }
        return { domNodes: [container] };
    },

    // --- Logging System ---

    distributeVerticalSpace: function () {
        if (this._distributeTimer) cancelAnimationFrame(this._distributeTimer);
        this._distributeTimer = requestAnimationFrame(() => {
            const calendarEl = document.querySelector('#calendar');
            if (!calendarEl || !this.state.calendar) return;

            // Only run on Screen mode
            if (document.body.classList.contains('printing-mode')) return;

            // 1. Reset bottom heights to measure natural height
            // Only touch visible rows to prevent hidden rows from expanding the scroller
            const visibleRows = Array.from(calendarEl.querySelectorAll('.fc-daygrid-body table tr'))
                .filter(row => row.offsetParent !== null);

            if (visibleRows.length === 0) return;

            const bottomEls = [];
            visibleRows.forEach(row => {
                row.querySelectorAll('.fc-daygrid-day-bottom').forEach(el => {
                    el.style.height = '0px';
                    bottomEls.push(el);
                });
            });

            // 2. Dynamic Measurement
            const windowHeight = window.innerHeight;
            const mainContent = document.querySelector('#main-content');
            if (!mainContent) return;

            // Target Height: Space available for the calendar within the main container
            const rect = mainContent.getBoundingClientRect();
            const availableTotal = windowHeight - rect.top;

            // Safety Margin (Buffer) to prevent accidental overflow
            // Reduced to minimize the "gap" at the bottom
            const safetyMargin = 10;

            // Sum up existing non-stretchable heights
            const toolbar = document.querySelector('.fc-header-toolbar');
            const colHeader = document.querySelector('.fc-col-header');
            const footer = document.querySelector('footer');

            const toolH = toolbar ? toolbar.offsetHeight : 0;
            const headH = colHeader ? colHeader.offsetHeight : 0;
            const footH = footer ? footer.offsetHeight : 0;

            const overhead = toolH + headH + footH + safetyMargin;

            let contentH = 0;
            visibleRows.forEach(row => {
                contentH += row.offsetHeight;
            });

            // 3. Calculate Distribution
            const remainder = availableTotal - (overhead + contentH);

            // 4. Distribute space
            const rowCount = visibleRows.length;
            const heightPerWeek = Math.floor(remainder / rowCount);

            // USER REQUEST: Minimum 60px for cell bottom (memo space)
            const finalGap = Math.max(60, heightPerWeek);

            bottomEls.forEach(el => {
                el.style.height = `${finalGap}px`;
            });

            // Force FullCalendar to sync after we modified internal DOM
            // REMOVED: updateSize() causes infinite resize loop in some conditions
            // setTimeout(() => {
            //     if (this.state.calendar) this.state.calendar.updateSize();
            // }, 50);
        });
    },

    logAction: async function (action, table, targetId, details) {
        if (!this.state.user) return;

        // Fire and forget
        window.SupabaseClient.supabase.from('audit_logs').insert([{
            user_id: this.state.user.id,
            action_type: action,
            target_table: table,
            target_id: targetId,
            changes: JSON.stringify(details)
        }]).then(({ error }) => {
            if (error) console.error("Audit Log Error:", error);
        });
    },

    logError: async function (msg, url, line, col, errorObj) {
        const errDetails = {
            msg: msg,
            url: url,
            line: line,
            col: col,
            stack: errorObj?.stack
        };
        console.error("Capturing Client Error:", errDetails);

        window.SupabaseClient.supabase.from('error_logs').insert([{
            error_message: msg,
            stack_trace: JSON.stringify(errDetails),
            user_id: this.state.user?.id || null // Log user if known
        }]).then(({ error }) => {
            if (error) console.error("Failed to log error to DB:", error);
        });
    }
};

// Global Error Handler
window.onerror = function (msg, url, line, col, error) {
    if (window.App && window.App.logError) {
        window.App.logError(msg, url, line, col, error);
    }
    return false; // Let default handler run too
};

// Start Application
document.addEventListener('DOMContentLoaded', () => {
    window.App = App; // Expose for inline handlers
    App.init();
});

