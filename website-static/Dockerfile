FROM nginx:1.27-alpine

COPY website-static/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY website-static/index.html /usr/share/nginx/html/index.html
COPY website-static/favicon.ico /usr/share/nginx/html/favicon.ico
COPY website-static/404.html /usr/share/nginx/html/404.html
COPY website-static/site.css /usr/share/nginx/html/site.css
COPY website-static/site.js /usr/share/nginx/html/site.js
COPY website-static/robots.txt /usr/share/nginx/html/robots.txt
COPY website-static/sitemap.xml /usr/share/nginx/html/sitemap.xml
COPY website-static/assets /usr/share/nginx/html/assets
COPY website-static/demo /usr/share/nginx/html/demo
COPY website-static/guides /usr/share/nginx/html/guides
COPY website-static/privacy /usr/share/nginx/html/privacy
COPY public/brand /usr/share/nginx/html/brand

EXPOSE 8080
