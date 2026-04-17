// SW update toast (non-blocking notification when new version available)
if ('serviceWorker' in navigator) {
    var _swUpdateShown = false;
    navigator.serviceWorker.addEventListener('controllerchange', function() {
        if (_swUpdateShown) return;
        _swUpdateShown = true;
        var toast = document.createElement('div');
        toast.setAttribute('role', 'alert');
        toast.style.cssText = 'position:fixed;bottom:calc(80px + env(safe-area-inset-bottom,0px));left:50%;transform:translateX(-50%);background:#111;color:#fff;padding:12px 16px;border-radius:14px;box-shadow:0 10px 25px rgba(0,0,0,.3);z-index:99999;display:flex;align-items:center;gap:12px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;max-width:92vw';
        var msg = document.createElement('span');
        msg.textContent = 'Доступна нова версія';
        var btn = document.createElement('button');
        btn.textContent = 'Оновити';
        btn.style.cssText = 'background:#fff;color:#000;border:none;padding:6px 12px;border-radius:8px;font-weight:600;cursor:pointer;font-size:13px';
        btn.onclick = function() {
            if (navigator.serviceWorker.controller) {
                navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' });
            }
            location.reload();
        };
        var close = document.createElement('button');
        close.textContent = '\u2715';
        close.setAttribute('aria-label', 'Закрити');
        close.style.cssText = 'background:transparent;color:#888;border:none;padding:4px 8px;cursor:pointer;font-size:16px';
        close.onclick = function() { toast.remove(); };
        toast.appendChild(msg);
        toast.appendChild(btn);
        toast.appendChild(close);
        document.body.appendChild(toast);
    });
}

// Install overlay theme-color fix on hashchange
window.addEventListener('hashchange', function() {
    var m = document.getElementById('metaThemeColor');
    if (location.hash === '#installOverlay') {
        if (m) m.content = '#ffffff';
        document.documentElement.style.backgroundColor = '#fff';
        document.body.style.backgroundColor = '#fff';
    } else {
        var d = document.body.getAttribute('data-theme') === 'dark';
        var c = d ? '#000000' : '#ffffff';
        if (m) m.content = c;
        document.documentElement.style.backgroundColor = c;
        document.body.style.backgroundColor = '';
    }
});

// Install overlay close handler (moved from inline onclick)
document.addEventListener('DOMContentLoaded', function() {
    var closeLink = document.querySelector('.install-close');
    if (closeLink) {
        closeLink.addEventListener('click', function(event) {
            event.preventDefault();
            history.replaceState(null, '', location.pathname + location.search);
            var overlay = document.getElementById('installOverlay');
            if (overlay) {
                overlay.style.display = 'none';
                setTimeout(function() { overlay.style.display = ''; }, 100);
            }
        });
    }
});
