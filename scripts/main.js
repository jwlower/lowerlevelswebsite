document.addEventListener('DOMContentLoaded', function() {
  const feed = document.getElementById('post-feed');
  if (!feed) return;

  fetch('posts/posts.json')
    .then(response => response.json())
    .then(posts => {
      feed.innerHTML = '';
      posts.forEach(post => {
        const div = document.createElement('div');
        div.className = 'post-preview';
        div.innerHTML = `
          <h4>${post.title}</h4>
          <p class="post-date">${post.date}</p>
          <p>${post.excerpt}</p>
          <a href="posts/${post.file}">Read More</a>
        `;
        feed.appendChild(div);
      });
    })
    .catch(err => {
      feed.innerHTML = '<p>Could not load posts.</p>';
    });
});
