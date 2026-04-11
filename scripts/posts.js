// posts.js — Shared post loader for all pages
//
// Drop this anywhere on a page:
//   <div class="post-feed" data-json="path/to/posts.json"></div>
//
// Optional attributes on the div:
//   data-post-path   Base path to post.html for blog post links.
//                    Default: "post.html"  (correct when used from site root)
//                    Set to "../post.html" on any page one folder deep.
//
// THREE POST TYPES — detected automatically from the JSON entry:
//
//   Blog post (Markdown file, rendered via post.html):
//   { "title":"...", "date":"...", "excerpt":"...", "slug":"2026-01-01-my-post",
//     "tags":["motw","general"], "type":"blog" }
//
//   Session report (same as blog post but with extra meta):
//   { ..., "type":"session", "system":"MotW", "players":4, "duration":"3h" }
//
//   Document post (link to Google Drive or any URL):
//   { "title":"...", "date":"...", "description":"...", "link":"https://..." }
//
//   Announcement (inline body text, optional link):
//   { "title":"...", "date":"...", "body":"...", "link":"https://..." }

document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('.post-feed').forEach(function (feed) {
        var jsonPath  = feed.dataset.json;
        var postPath  = feed.dataset.postPath || 'post.html';
        if (!jsonPath) return;

        fetch(jsonPath)
            .then(function (response) {
                if (!response.ok) throw new Error('Not found');
                return response.json();
            })
            .then(function (posts) {
                feed.innerHTML = '';
                if (!posts.length) {
                    feed.innerHTML = '<p class="no-posts">No posts yet. Check back soon!</p>';
                    return;
                }

                posts.forEach(function (post) {
                    var div = document.createElement('div');

                    // ── Announcement ──────────────────────────────────────
                    if (post.body !== undefined) {
                        div.className = 'announcement-post';
                        var linkHtml = post.link
                            ? '<a class="doc-link" href="' + post.link
                              + '" target="_blank" rel="noopener noreferrer">Details &rarr;</a>'
                            : '';
                        div.innerHTML =
                            '<h4>' + post.title + '</h4>'
                            + '<span class="post-date">' + post.date + '</span>'
                            + '<p>' + post.body + '</p>'
                            + linkHtml;

                    // ── Blog post or Session report ───────────────────────
                    } else if (post.slug) {
                        div.className = 'doc-post';

                        var sessionBadge = post.type === 'session'
                            ? '<span class="session-badge">Session Report</span><br>'
                            : '';

                        var sessionMeta = '';
                        if (post.type === 'session') {
                            var parts = [];
                            if (post.system)   parts.push('<span>System: ' + post.system + '</span>');
                            if (post.players)  parts.push('<span>Players: ' + post.players + '</span>');
                            if (post.duration) parts.push('<span>Duration: ' + post.duration + '</span>');
                            if (parts.length) {
                                sessionMeta = '<div class="session-meta">' + parts.join('') + '</div>';
                            }
                        }

                        var tags = post.tags && post.tags.length ? post.tags : [];
                        var tagsHtml = tags.length
                            ? '<div class="post-tags">'
                              + tags.map(function (t) {
                                  return '<span class="tag-pill">' + t + '</span>';
                              }).join('')
                              + '</div>'
                            : '';

                        div.setAttribute('data-tags', tags.join(','));
                        div.innerHTML =
                            sessionBadge
                            + '<h4>' + post.title + '</h4>'
                            + '<span class="post-date">' + post.date + '</span>'
                            + tagsHtml
                            + sessionMeta
                            + '<p>' + post.excerpt + '</p>'
                            + '<a class="doc-link" href="' + postPath + '?p=' + post.slug
                            + '">Read Post &rarr;</a>';

                    // ── Document link (Google Drive / external URL) ───────
                    } else {
                        div.className = 'doc-post';
                        div.innerHTML =
                            '<h4>' + post.title + '</h4>'
                            + '<span class="post-date">' + post.date + '</span>'
                            + '<p>' + post.description + '</p>'
                            + '<a class="doc-link" href="' + post.link
                            + '" target="_blank" rel="noopener noreferrer">View Document &rarr;</a>';
                    }

                    feed.appendChild(div);
                });
            })
            .catch(function () {
                feed.innerHTML = '<p class="no-posts">Could not load posts.</p>';
            });
    });
});
