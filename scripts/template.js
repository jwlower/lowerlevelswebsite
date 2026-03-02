// template.js
// Reads data-game and data-base from <body>, then injects the site shell
// (header, left sidebar, right sidebar, footer) around #page-content.
// Dispatches a 'template-applied' CustomEvent so other scripts (e.g. posts)
// can run after the DOM is ready.

(function () {
  // --- Navigation items (href relative to site root, no leading slash) ---
  var NAV_ITEMS = [
    { href: 'index.html',      label: 'Home',               game: 'home' },
    { href: 'dnd/index.html',  label: 'D&D 2024',           game: 'dnd'  },
    { href: 'motw/index.html', label: 'Monster of the Week', game: 'motw' },
    // Add new games here — one entry per game folder
  ];

  // --- Left-sidebar config per game ---
  // Links are page-relative (or absolute for external URLs).
  var SIDEBAR_CONFIG = {
    home: {
      title: 'Explore',
      links: [
        { href: 'dnd/index.html',  label: 'D&D 2024' },
        { href: 'motw/index.html', label: 'Monster of the Week' },
        // Add new game links here
      ],
    },
    dnd: {
      title: 'D&D Resources',
      links: [
        {
          href: 'https://www.dndbeyond.com/posts/1804-start-playing-today-with-the-2024-d-d-free-rules',
          label: '2024 Free Rules',
          external: true,
        },
        {
          href: 'https://www.dndbeyond.com/srd',
          label: 'SRD v5.2.1',
          external: true,
        },
        {
          href: 'https://roll20.net/compendium/dnd5e/Free%20Basic%20Rules%20%282024%29',
          label: 'Free Basic Rules (Roll20)',
          external: true,
        },
        { href: 'character-creator.html', label: 'Character Creator WIP!!' },
      ],
    },
    motw: {
      title: 'MotW Resources',
      links: [
        { href: '#', label: 'Monster List' },
        { href: '#', label: "Hunter's Guide" },
        // Add more MotW resource links here
      ],
    },
    // Add new game sidebar configs here
  };

  // --- Right sidebar (same on every page) ---
  var RIGHT_SIDEBAR_HTML = [
    '<div class="sidebar-box">',
    '  <h3>Socials</h3>',
    '  <!-- Add Discord / social links here -->',
    '</div>',
    '<div class="sidebar-box">',
    '  <h3>Support</h3>',
    '  <!-- Add Patreon / Ko-fi link here -->',
    '</div>',
  ].join('\n');

  // --- Footer (same on every page) ---
  var FOOTER_HTML = '<p>&copy; ' + new Date().getFullYear() + ' Lower Levels &mdash; Made with &#9829; for TTRPGs</p>';

  // -------------------------------------------------------------------

  function applyTemplate() {
    var body   = document.body;
    var game   = body.getAttribute('data-game') || 'home';
    var base   = body.getAttribute('data-base')  || '.';
    var sidebar = SIDEBAR_CONFIG[game] || SIDEBAR_CONFIG.home;

    // Build top nav
    var navHTML = NAV_ITEMS.map(function (item) {
      var href     = base + '/' + item.href;
      var isActive = item.game === game;
      var cls      = isActive ? ' class="nav-active"' : '';
      return '<a href="' + href + '"' + cls + '>' + item.label + '</a>';
    }).join('\n          ');

    // Build left sidebar links
    var sidebarLinksHTML = sidebar.links.map(function (link) {
      var ext = link.external ? ' target="_blank" rel="noopener noreferrer"' : '';
      return '<a href="' + link.href + '"' + ext + '>' + link.label + '</a>';
    }).join('\n            ');

    // Capture center content before we blow away the body
    var contentEl  = document.getElementById('page-content');
    var centerHTML = contentEl ? contentEl.innerHTML : '';

    // Rebuild the full body
    body.innerHTML = [
      '<header>',
      '  <h1>Lower Levels Tabletop Hub</h1>',
      '  <nav>',
      '    ' + navHTML,
      '  </nav>',
      '</header>',
      '<main class="container">',
      '  <aside class="left-column">',
      '    <h3>' + sidebar.title + '</h3>',
      '    <nav>',
      '      ' + sidebarLinksHTML,
      '    </nav>',
      '  </aside>',
      '  <section class="center-column">',
      '    ' + centerHTML,
      '  </section>',
      '  <aside class="right-column">',
      '    ' + RIGHT_SIDEBAR_HTML,
      '  </aside>',
      '</main>',
      '<footer>',
      '  ' + FOOTER_HTML,
      '</footer>',
    ].join('\n');

    // Let other scripts know the template is ready
    document.dispatchEvent(
      new CustomEvent('template-applied', { detail: { game: game, base: base } })
    );
  }

  document.addEventListener('DOMContentLoaded', applyTemplate);
}());
