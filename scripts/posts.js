// posts.js - Shared post loader for all pages
//
// Usage: add a <div class="post-feed" data-json="path/to/posts.json"></div>
// anywhere on a page and this script will populate it automatically.
//
// TWO POST TYPES are detected automatically from the JSON entry:
//
//   Blog post preview (links to a full HTML page):
//   { "title": "...", "date": "...", "excerpt": "...", "file": "posts/my-post.html" }
//
//   Document post (links directly to Google Drive or any URL):
//   { "title": "...", "date": "...", "description": "...", "link": "https://..." }

document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('.post-feed').forEach(function (feed) {
        var jsonPath = feed.dataset.json;
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
                    div.className = 'doc-post';

                    if (post.file) {
                        // Blog post preview — links to a full HTML page
                        div.innerHTML =
                            '<h4>' + post.title + '</h4>' +
                            '<span class="post-date">' + post.date + '</span>' +
                            '<p>' + post.excerpt + '</p>' +
                            '<a class="doc-link" href="' + post.file + '">Read Post &rarr;</a>';
                    } else {
                        // Document post — links to Google Drive or external URL
                        div.innerHTML =
                            '<h4>' + post.title + '</h4>' +
                            '<span class="post-date">' + post.date + '</span>' +
                            '<p>' + post.description + '</p>' +
                            '<a class="doc-link" href="' + post.link + '" target="_blank" rel="noopener noreferrer">View Document &rarr;</a>';
                    }

                    feed.appendChild(div);
                });
            })
            .catch(function () {
                feed.innerHTML = '<p class="no-posts">Could not load posts.</p>';
            });
    });
});
