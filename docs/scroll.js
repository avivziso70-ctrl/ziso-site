/* Mounts the scroll-craft engine on the home page only. Restrained by design:
   parallax depth on the hero and the family portraits, a light pointer tilt on
   the product photos. Nothing is hidden before it animates, so the page reads
   the same with JS off, and the engine itself stands still under
   prefers-reduced-motion and on touch screens (tilt). */
(function(){if(window.ScrollCraft)window.ScrollCraft.mount(document)})();
