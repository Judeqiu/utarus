/**
 * Legacy entry — kept so old caches / bookmarks to /signup/app.js still work.
 * Prefer /signup/embed.js (mounts into #utarus-signup-root).
 */
(function () {
  var s = document.createElement('script');
  s.src = '/signup/embed.js';
  s.defer = true;
  document.head.appendChild(s);
})();
