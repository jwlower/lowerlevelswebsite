// main.js
// Listens for 'template-applied' (fired by template.js after the shell is built),
// then fetches posts.json and renders post previews filtered by game.
// Home page (game = 'home') shows all posts; game pages show only their game's posts.

document.addEventListener('template-applied', function (e) {
  var game = e.detail.game;
  var base = e.detail.base;

  var feed = document.getElementById('post-feed');
  if (!feed) return;

  fetch(base + '/posts/posts.json')
    .then(function (response) { return response.json(); })
    .then(function (posts) {
      // Filter posts: home shows everything, game pages show only matching game
      var filtered = (game === 'home')
        ? posts
        : posts.filter(function (p) { return p.game === game; });

      feed.innerHTML = '';

      if (filtered.length === 0) {
        feed.innerHTML = '<p>No posts yet &mdash; check back soon!</p>';
        return;
      }

      filtered.forEach(function (post) {
        var div = document.createElement('div');
        div.className = 'post-preview';
        div.innerHTML =
          '<h4>' + post.title + '</h4>' +
          '<p class="post-date">' + post.date + '</p>' +
          '<p>' + post.excerpt + '</p>' +
          '<a href="' + base + '/' + post.file + '">Read More</a>';
        feed.appendChild(div);
      });
    })
    .catch(function () {
      feed.innerHTML = '<p>Could not load posts.</p>';
    });
});
