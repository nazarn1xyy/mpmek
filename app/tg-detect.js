// Telegram Mini App detection — runs before body renders
// Must be loaded synchronously (no defer) to prevent FOUC
if (window.Telegram && window.Telegram.WebApp) {
    document.documentElement.classList.add('in-tg-webapp');
    try { window.Telegram.WebApp.ready(); window.Telegram.WebApp.expand(); } catch(e) {}
    function _tgForceStyle() {
        document.querySelectorAll('.top-nav,.ob-intro,.ob-auth,.onboarding-content').forEach(function(el){
            el.style.setProperty('padding-top', '110px', 'important');
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _tgForceStyle);
    } else { _tgForceStyle(); }
    new MutationObserver(_tgForceStyle).observe(document.documentElement, {childList:true, subtree:true});
}
