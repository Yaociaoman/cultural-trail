(() => {
    const hint = (message, isError = true) => {
        const el = document.getElementById('auth-hint');
        el.textContent = message;
        el.style.display = 'block';
        el.style.color = isError ? '#ffdd6b' : '#b7e4c7';
    };
    const hideHint = () => { document.getElementById('auth-hint').style.display = 'none'; };

    async function loadAccount(user) {
        currentUserEmail = user.email;
        unlockedStamps.clear();
        stampPhotos = {};
        const [stamps, points] = await Promise.all([TrailAPI.get('/api/stamps'), TrailAPI.get('/api/points')]);
        stamps.stamps.forEach(stamp => {
            unlockedStamps.add(stamp.locationId);
            stampPhotos[stamp.locationId] = stamp.photoUrl;
        });
        const badge = document.getElementById('account-points');
        if (badge) badge.textContent = `${points.points} points`;
        enterApp(user.username);
    }

    window.TravelAuth = {
        async submit(mode) {
            const email = document.getElementById('email-input').value.trim();
            const password = document.getElementById('password-input').value;
            const username = document.getElementById('username-input').value.trim();
            if (mode === 'register' && (password.length < 10 || password.length > 128)) {
                hint('註冊密碼需為 10 到 128 個字元。');
                return;
            }
            try {
                const path = mode === 'register' ? '/api/auth/register' : '/api/auth/login';
                const result = await TrailAPI.post(path, { email, password, username });
                hideHint();
                await loadAccount(result.user);
            } catch (error) { hint(error.message); }
        },
        async restore() {
            try {
                const { user } = await TrailAPI.get('/api/auth/me');
                await loadAccount(user);
            } catch (error) {
                if (error.status !== 401) console.warn('Could not restore session:', error.message);
            }
        },
        async signOut() {
            try { await TrailAPI.post('/api/auth/logout', {}); }
            catch (error) { if (error.status !== 401) hint(error.message); }
            currentUserEmail = null;
            unlockedStamps.clear();
            stampPhotos = {};
            document.getElementById('email-input').value = '';
            document.getElementById('password-input').value = '';
            setAuthMode('login');
            const page = document.getElementById('start-page');
            page.style.display = 'flex';
            page.classList.remove('fade-out');
            closePanel();
        }
    };
})();
