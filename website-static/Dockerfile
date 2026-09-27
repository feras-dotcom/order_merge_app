FROM nginx:1.27-alpine

COPY website-static/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY website-static/index.html /usr/share/nginx/html/index.html
COPY website-static/privacy /usr/share/nginx/html/privacy
COPY app/routes/_index/styles.module.css /usr/share/nginx/html/site.css
COPY public/favicon.ico /usr/share/nginx/html/favicon.ico
COPY public/apple-touch-icon.png /usr/share/nginx/html/apple-touch-icon.png
COPY public/brand /usr/share/nginx/html/brand

EXPOSE 8080
