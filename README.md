# lowerlevelswebsite
My website for my personal projects

# Adding a blog post (3 steps):

Copy posts/template.html → posts/my-new-post.html
Open that file, change the title/date/content — including any Google Drive links like this:
<a class="post-doc-link" href="https://drive.google.com/your-link"
   target="_blank" rel="noopener noreferrer">
    My Document Name →
</a>

Add one entry to posts/posts.json:
{
  "title": "My New Post",
  "date": "2026-03-03",
  "excerpt": "One sentence teaser that shows on the home page.",
  "file": "posts/my-new-post.html"
}

The home page feed updates automatically. The full post lives in its own clean file.

To test it locally run this from the project folder:

python -m http.server 8000

Then open http://localhost:8000 — you need a local server because the browser blocks fetch() on plain file:// URLs. The welcome post is already wired up so you'll see it in the feed immediately.