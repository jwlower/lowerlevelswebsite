# lowerlevelswebsite
My website for my personal projects

# Dev Notes

Blog Post Pages: Duplicate index.html as post-name.html, change the title and post content.

Navigation: Add more links to the left column manually.

Comments: You can use something like Disqus or Giscus for embedded comments later.

Hosting: You can upload this to Neocities for a retro vibe or GitHub Pages for free hosting.
 - Hosting neocites: https://lowerlevescreations.neocities.org/


## Hosting
In the main directory, run this command
  python -m http.server 8000
then visit: http://localhost:8000/

## AI Design & Development Reminder Prompt
Use this prompt to remind the AI (or any collaborator) of the project’s vision, style, and requirements:
Prompt:
> Act as a lead web designer and front-end developer specializing in retro web aesthetics and user-friendly, easily extensible static sites for hobbyist communities.
>
> I am building a personal tabletop gaming blog to host links to PDFs for Monster of the Week (MotW) and Dungeons & Dragons 2024. The site should be easy to expand for future games (like Pathfinder 2e, my own systems, and board games). The design must evoke an early 2000s, Commodore 64-inspired, blocky, DIY aesthetic—thick lines, monospaced or pixel fonts, and a "built by one person" vibe (without stating it directly). All code should be well-commented, especially where to add a comments section and a Discord link.
>
> Please provide:
> - A site structure outline (list or diagram)
> - Sample HTML/CSS/JS code snippets with comments
> - A style guide (colors, fonts, spacing)
> - Clear, step-by-step instructions for adding new games/pages, a comments section, and a Discord link
> - At least two concrete visual examples (e.g., code for a header and a navigation menu)
>
> Constraints:
> - Use only HTML, CSS, and vanilla JS (no frameworks)
> - No external dependencies except for fonts (if needed)
> - Keep all instructions and comments clear and beginner-friendly
> - Avoid technical jargon
> - Ensure the site is accessible and mobile-friendly
> - Limit each code example to under 40 lines
> - Output should not exceed 500 words per section
>
> Examples of what I like:
> - Navigation bar with thick borders and pixel font
> - PDF link styled in the retro theme
> - Code comments like <!-- Add Discord link here --> and <!-- Insert comments section here (see instructions below) -->