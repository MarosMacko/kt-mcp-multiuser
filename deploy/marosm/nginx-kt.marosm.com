# kt.marosm.com - kt-mcp: Kalorické tabuľky MCP connector for Claude (multi-user).
# Upstream: kt-mcp.service on 127.0.0.1:8092. Source: ~/kt-mcp (branch marosm), deploy/marosm/.
# Only /authorize (the sign-in page, opened in the user's own browser) is public. Everything else -
# MCP calls, OAuth discovery/registration/token - comes from Claude's servers, so it is limited to
# Anthropic's published outbound range (https://platform.claude.com/docs/en/api/ip-addresses).
server {
    include /etc/nginx/snippets/http-cat-location.conf;
    server_name kt.marosm.com;

    # OAuth and MCP errors (401 + WWW-Authenticate, JSON bodies) must reach Claude untouched;
    # the global http-cat config would replace them with cat pages.
    proxy_intercept_errors off;
    client_max_body_size 1m;

    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    # Overwrite, don't append: the app trusts exactly one proxy hop (us).
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    # MCP responses may stream (SSE).
    proxy_buffering off;
    proxy_read_timeout 300s;

    # Sign-in page. add_header in a location replaces the server-level ones, so all headers live here.
    location = /authorize {
        add_header X-Robots-Tag "noindex, nofollow" always;
        add_header Referrer-Policy "no-referrer" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-Frame-Options "DENY" always;
        add_header Strict-Transport-Security "max-age=31536000" always;
        add_header Content-Security-Policy "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://claude.ai https://claude.com; frame-ancestors 'none'; base-uri 'none'" always;
        proxy_pass http://127.0.0.1:8092;
    }

    location / {
        allow 160.79.104.0/21;
        deny all;
        add_header X-Robots-Tag "noindex, nofollow" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Strict-Transport-Security "max-age=31536000" always;
        proxy_pass http://127.0.0.1:8092;
    }

    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/kt.marosm.com/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/kt.marosm.com/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot

}

server {
    include /etc/nginx/snippets/http-cat-location.conf;
    if ($host = kt.marosm.com) {
        return 301 https://$host$request_uri;
    } # managed by Certbot


    server_name kt.marosm.com;
    listen 80;
    return 404; # managed by Certbot


}