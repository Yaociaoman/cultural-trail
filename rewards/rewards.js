(() => {
    const state = { activePanel: 'ledger', points: 0, entries: [], rewards: [], redemptions: [], busy: false };
    const byId = id => document.getElementById(id);

    function setNotice(message = '', kind = 'info') {
        const notice = byId('rewards-notice');
        if (!notice) return;
        notice.textContent = message;
        notice.className = message ? `rewards-notice ${kind}` : 'rewards-notice';
        notice.hidden = !message;
    }

    function formatDate(value) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium' }).format(date);
    }

    function makeEmpty(message) {
        const element = document.createElement('div');
        element.className = 'rewards-empty';
        element.textContent = message;
        return element;
    }

    function renderEntries() {
        const list = byId('points-ledger-list');
        list.replaceChildren();
        if (!state.entries.length) {
            list.append(makeEmpty('目前還沒有點數紀錄。完成集章後，獲得的點數會顯示在這裡。'));
            return;
        }
        for (const entry of state.entries) {
            const row = document.createElement('article');
            row.className = 'points-entry';
            const details = document.createElement('div');
            details.className = 'points-entry-details';
            const title = document.createElement('strong');
            title.textContent = entry.reason === 'stamp' ? '完成景點集章' : entry.reason === 'redemption' ? '兌換獎勵' : '點數紀錄';
            const date = document.createElement('time');
            date.textContent = formatDate(entry.createdAt);
            details.append(title, date);
            const amount = document.createElement('span');
            amount.className = `points-entry-amount ${entry.amount >= 0 ? 'earned' : 'spent'}`;
            amount.textContent = `${entry.amount > 0 ? '+' : ''}${entry.amount} 點`;
            row.append(details, amount);
            list.append(row);
        }
    }

    function renderRewards() {
        const list = byId('rewards-list');
        list.replaceChildren();
        if (!state.rewards.length) {
            list.append(makeEmpty('獎勵內容正在準備中，之後會在這裡公布可兌換項目。'));
            return;
        }
        for (const reward of state.rewards) {
            const card = document.createElement('article');
            card.className = 'reward-card';
            const copy = document.createElement('div');
            copy.className = 'reward-copy';
            const name = document.createElement('h3');
            name.textContent = reward.name;
            const description = document.createElement('p');
            description.textContent = reward.description || '永續旅行的專屬回饋';
            const cost = document.createElement('span');
            cost.className = 'reward-cost';
            cost.textContent = `${reward.cost} 點`;
            copy.append(name, description, cost);

            const outOfStock = reward.stock !== null && reward.stock <= 0;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'reward-redeem-btn';
            button.textContent = outOfStock ? '已兌換完' : state.points < reward.cost ? '點數不足' : '立即兌換';
            button.disabled = state.busy || outOfStock || state.points < reward.cost;
            button.addEventListener('click', () => redeem(reward.id));
            card.append(copy, button);
            list.append(card);
        }
    }

    function renderRedemptions() {
        const list = byId('redemptions-list');
        list.replaceChildren();
        if (!state.redemptions.length) {
            list.append(makeEmpty('尚無兌換紀錄。完成集章累積點數後，可兌換喜歡的獎勵。'));
            return;
        }
        for (const item of state.redemptions) {
            const row = document.createElement('article');
            row.className = 'points-entry';
            const details = document.createElement('div');
            details.className = 'points-entry-details';
            const name = document.createElement('strong');
            name.textContent = item.name;
            const date = document.createElement('time');
            date.textContent = formatDate(item.createdAt);
            details.append(name, date);
            const amount = document.createElement('span');
            amount.className = 'points-entry-amount spent';
            amount.textContent = `-${item.pointsSpent} 點`;
            row.append(details, amount);
            list.append(row);
        }
    }

    function render() {
        byId('rewards-balance').textContent = `${state.points}`;
        renderEntries();
        renderRewards();
        renderRedemptions();
    }

    async function refresh() {
        setNotice();
        try {
            const [points, rewards, redemptions] = await Promise.all([
                TrailAPI.get('/api/points'),
                TrailAPI.get('/api/rewards'),
                TrailAPI.get('/api/redemptions')
            ]);
            state.points = points.points;
            state.entries = points.entries || [];
            state.rewards = rewards.rewards || [];
            state.redemptions = redemptions.redemptions || [];
            render();
        } catch (error) {
            setNotice(error.message || '載入點數資料失敗，請稍後再試。', 'error');
        }
    }

    async function redeem(rewardId) {
        const reward = state.rewards.find(item => item.id === rewardId);
        if (!reward || state.busy) return;
        if (!window.confirm(`確定使用 ${reward.cost} 點兌換「${reward.name}」嗎？`)) return;
        state.busy = true;
        renderRewards();
        setNotice('正在處理兌換…', 'info');
        try {
            await TrailAPI.post('/api/redemptions', { rewardId });
            await refresh();
            setNotice(`已成功兌換「${reward.name}」。`, 'success');
        } catch (error) {
            setNotice(error.message || '兌換失敗，請稍後再試。', 'error');
        } finally {
            state.busy = false;
            renderRewards();
        }
    }

    function showPanel(panel, button) {
        state.activePanel = panel;
        document.querySelectorAll('.rewards-tab').forEach(tab => {
            const selected = tab.dataset.panel === panel;
            tab.classList.toggle('active', selected);
            tab.setAttribute('aria-selected', String(selected));
        });
        document.querySelectorAll('.rewards-panel').forEach(section => {
            section.hidden = section.id !== `rewards-panel-${panel}`;
        });
        if (button) button.focus();
    }

    document.addEventListener('click', event => {
        const button = event.target.closest('.rewards-tab');
        if (button) showPanel(button.dataset.panel, button);
    });

    window.TravelRewards = { refresh };
    document.addEventListener('DOMContentLoaded', () => showPanel('ledger'));
})();
