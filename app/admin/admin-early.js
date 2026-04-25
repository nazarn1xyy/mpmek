// Login handler — runs before admin-boot-v5.js
// Uses form 'submit' event (most reliable on iOS Safari)
(function(){
    var busy = false;
    var form = document.getElementById('loginForm');
    if (!form) return;

    form.addEventListener('submit', function(e) {
        e.preventDefault();
        if (busy) return;
        var hint = document.getElementById('loginHint');
        var btn = document.getElementById('loginSubmit');
        var u = document.getElementById('loginUsername').value.trim().toLowerCase();
        var p = document.getElementById('loginPassword').value;
        if (!u || !p) { hint.textContent = 'Введіть логін і пароль'; hint.style.color = '#ff4444'; return; }
        busy = true;
        if (btn) { btn.disabled = true; btn.textContent = 'Вхід...'; }
        hint.textContent = 'Вхід...';
        hint.style.color = '';
        fetch('/api/auth?action=login', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({username: u, password: p})
        }).then(function(r){ return r.json().then(function(d){ return {ok:r.ok, data:d}; }); })
        .then(function(res){
            if (!res.ok) { hint.textContent = res.data.error || 'Помилка'; hint.style.color='#ff4444'; if(btn){btn.disabled=false; btn.textContent='Увійти';} busy=false; return; }
            localStorage.setItem('authToken', res.data.token);
            window._loginUser = res.data.user;
            if (window._onLoginSuccess) { window._onLoginSuccess(res.data); }
            else { location.reload(); }
        }).catch(function(err){ hint.textContent = 'Помилка: ' + err.message; hint.style.color='#ff4444'; if(btn){btn.disabled=false; btn.textContent='Увійти';} busy=false; });
    });

    window._doLogin = true;
})();

// PIN handler
(function(){
    var pinCode = '';
    var dots = document.querySelectorAll('.pin-dot');
    var pinScreen = document.getElementById('pinScreen');
    function upd() {
        for (var i = 0; i < dots.length; i++) {
            dots[i].setAttribute('data-filled', i < pinCode.length ? 'true' : 'false');
        }
    }
    function tap(e) {
        e.preventDefault();
        e.stopPropagation();
        var btn = e.currentTarget;
        if (btn.id === 'pinDelete') {
            pinCode = pinCode.slice(0, -1);
            if (pinScreen) pinScreen.classList.remove('error');
            upd();
            return;
        }
        var v = btn.getAttribute('data-val');
        if (!v || pinCode.length >= 4) return;
        pinCode += v;
        upd();
        if (pinCode.length === 4 && window._onPinComplete) {
            setTimeout(function(){ window._onPinComplete(pinCode); }, 200);
        }
    }
    var btns = document.querySelectorAll('.pin-key[data-val], #pinDelete');
    for (var i = 0; i < btns.length; i++) {
        btns[i].addEventListener('touchstart', tap, {passive: false});
        btns[i].addEventListener('click', tap);
    }
    window._pinReset = function() { pinCode = ''; upd(); };
    window._getPinCode = function() { return pinCode; };
})();
