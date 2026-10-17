(() => {
    async function request(path, options = {}) {
        const response = await fetch(path, {
            credentials: 'same-origin',
            ...options,
            headers: { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...(options.headers || {}) }
        });
        if (response.status === 204) return null;
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(data.message || 'Request failed.');
            error.code = data.error || 'REQUEST_FAILED';
            error.status = response.status;
            throw error;
        }
        return data;
    }
    window.TrailAPI = {
        get: path => request(path),
        post: (path, body) => request(path, { method: 'POST', body: JSON.stringify(body) }),
        upload: (path, formData) => request(path, { method: 'POST', body: formData })
    };
})();
