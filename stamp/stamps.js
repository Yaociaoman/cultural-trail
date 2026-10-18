(() => {
    function showToast(message, kind) {
        const toast = document.getElementById('upload-toast');
        toast.className = kind;
        toast.textContent = message;
    }

    function removeManualFallback() {
        document.getElementById('manual-stamp-fallback')?.remove();
    }

    function showManualFallback(file) {
        removeManualFallback();

        const wrap = document.createElement('div');
        wrap.id = 'manual-stamp-fallback';
        wrap.className = 'manual-select-wrap';

        const label = document.createElement('span');
        label.textContent = 'We could not read the photo\'s GPS or location metadata. Select the place you actually visited to collect the stamp and points immediately. If the photo\'s capture time can\'t be read, the upload time will be recorded instead.';

        const select = document.createElement('select');
        select.setAttribute('aria-label', 'Select the place you visited');
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Choose a location';
        select.append(placeholder);

        const locations = Array.isArray(allLocations) ? allLocations : [];
        locations.forEach(location => {
            const option = document.createElement('option');
            option.value = location.id;
            option.textContent = location.name;
            select.append(option);
        });

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'manual-confirm-btn';
        button.textContent = 'Confirm manual stamp';
        button.addEventListener('click', async () => {
            if (!select.value) {
                showToast('Please choose a location you actually visited.', 'error');
                return;
            }
            button.disabled = true;
            try {
                await uploadFile(file, select.value);
                removeManualFallback();
            } catch (error) {
                showToast(error.message || 'Manual stamping failed. Please try again.', 'error');
            } finally {
                button.disabled = false;
            }
        });

        wrap.append(label, select, button);
        document.getElementById('upload-toast').insertAdjacentElement('afterend', wrap);
    }

    async function uploadFile(file, manualLocationId = '') {
        showToast(manualLocationId ? 'Uploading photo for manual stamping…' : 'Uploading photo and checking its GPS and capture time…', 'info');
        const form = new FormData();
        form.append('photo', file, file.name);
        if (manualLocationId) {
            form.append('manual', 'true');
            form.append('locationId', manualLocationId);
        }

        const { stamp, points } = await TrailAPI.upload('/api/stamps', form);
        unlockedStamps.add(stamp.locationId);
        stampPhotos[stamp.locationId] = stamp.photoUrl;
        const badge = document.getElementById('account-points');
        if (badge) badge.textContent = `${points} points`;
        renderStampGrid();
        const label = stamp.verificationMethod === 'manual' ? 'Manual stamp collected' : 'Stamp collected';
        showToast(`${label}: ${stamp.locationName}. Points have been added to your account.`, 'success');
        setTimeout(() => showSdgModal((allLocations.find(loc => loc.id === stamp.locationId) || {}).category), 700);
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
            removeManualFallback();
            try {
                await uploadFile(file);
            } catch (error) {
                showToast(error.message, 'error');
            if (
                error.code === 'GPS_REQUIRED' ||
                error.code === 'LOCATION_TOO_FAR' ||
                error.code === 'INVALID_EXIF'
                ) {
                    showManualFallback(file);
                }
            } finally {
                input.value = '';
            }
        }
    };
})();
