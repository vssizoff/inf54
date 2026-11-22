FROM node:22.4.0-alpine3.19 AS frontend-builder

WORKDIR /app

COPY ./frontend .

RUN npm i
RUN npm run build

FROM nginx:1.29.0-alpine3.22 AS server

RUN apk add --no-cache gettext nginx-mod-http-js

COPY --from=frontend-builder /app/dist /frontend
COPY ./nginx/nginx.conf /etc/nginx/nginx.conf
COPY ./nginx/urlencode.js /etc/nginx/urlencode.js
COPY ./nginx/config.js.template /config.js.template

COPY ./nginx/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]