(() => {
    function showToast(message, kind) {
        const toast = document.getElementById('upload-toast');
        toast.className = kind;
        toast.textContent = message;
    }
    window.TravelStamps = {
        async refresh() {
            const { stamps } = await TrailAPI.get('/api/stamps');
            unlockedStamps.clear();
            stampPhotos = {};
            stamps.forEach(stamp => {
                unlockedStamps.add(stamp.locationId);
                stampPhotos[stamp.locationId] = stamp.photoUrl;
            });
            renderStampGrid();
        },
        async upload(input) {
            const file = input.files && input.files[0];
            if (!file) return;
            showToast('正在上傳並驗證照片 GPS 與拍攝時間…', 'info');
            try {
                const form = new FormData();
                form.append('photo', file, file.name);
                const { stamp, points } = await TrailAPI.upload('/api/stamps', form);
                unlockedStamps.add(stamp.locationId);
                stampPhotos[stamp.locationId] = stamp.photoUrl;
                const badge = document.getElementById('account-points');
                if (badge) badge.textContent = `${points} points`;
                renderStampGrid();
                showToast(`集章成功：${stamp.locationName}（距離 ${stamp.distanceM} 公尺），獲得點數。`, 'success');
                setTimeout(() => showSdgModal((allLocations.find(loc => loc.id === stamp.locationId) || {}).category), 700);
            } catch (error) {
                showToast(error.message, 'error');
            } finally { input.value = ''; }
        }
    };
})();
