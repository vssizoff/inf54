FROM nginx:1.29.0-alpine3.22 AS server

RUN apk add --no-cache gettext nginx-mod-http-js

COPY ./nginx/dev.nginx.conf /etc/nginx/nginx.conf
COPY ./nginx/urlencode.js /etc/nginx/urlencode.js

CMD ["nginx", "-g", "daemon off;"]