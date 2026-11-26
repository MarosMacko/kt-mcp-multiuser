# Vlastný server

Návod, ako si kt-mcp-multiuser spustiť na vlastnom stroji, či už len pre seba, pre rodinu, alebo pre kohokoľvek.
Postup je napísaný tak, aby ho zvládol človek aj AI agent (pre agentov je skrátená verzia v [AGENTS.md](../AGENTS.md)).

## Čo potrebuješ

- **Stroj, ktorý beží nepretržite**: malý VPS (najlacnejší stačí), domáci server, NAS s Dockerom, Raspberry Pi.
  Na notebooku to funguje tiež, ale konektor žije a umiera s ním: keď notebook spí, asistent nič nezapíše
  a naplánované úlohy sa potichu nevykonajú.
- **Doménu** (alebo subdoménu), ktorá smeruje na ten stroj, a **otvorené porty 80 a 443**. MCP aj OAuth vyžadujú
  HTTPS; certifikát vybaví Caddy sám.
- **Docker** (variant A), alebo **Node.js 22+** a reverzná proxy (variant B).

Účet v Kalorických tabuľkách do konfigurácie nedávaš. Každý, kto server používa, sa prihlási vlastným účtom
na prihlasovacej stránke servera.

## Konfigurácia

Všetko sa nastavuje premennými prostredia; vzor s komentármi je v [`.env.example`](../.env.example).

| Premenná | Povinná | Význam |
|---|---|---|
| `PUBLIC_URL` | áno (bez Dockeru) | Verejná HTTPS adresa, napr. `https://kt.example.com`. Je to OAuth issuer, po zmene sa všetci pripájajú nanovo. |
| `KT_DOMAIN` | áno (Docker) | Len doména; `docker-compose.yml` z nej poskladá `PUBLIC_URL` a Caddy vybaví certifikát. |
| `CREDENTIALS_KEY` | áno | 32 náhodných bajtov v base64 (`openssl rand -base64 32`). Šifruje uložené prihlásenia. |
| `OPERATOR_NAME`, `OPERATOR_CONTACT` | odporúčané | Kto server prevádzkuje a kontakt; zobrazí sa na `/privacy`. Ak server púšťaš iným ľuďom, vyplň. |
| `ALLOWED_USERS_FILE` | nie | Cesta k zoznamu e-mailov, ktoré sa môžu prihlásiť. Prázdne = ktokoľvek. |
| `ALLOW_LOCAL_CLIENTS` | nie | `true` (predvolené) povolí lokálnych klientov (Claude Code, VS Code…). |
| `PUBLIC_USER_COUNT` | nie | `true` zverejní počet pripojených účtov na `/badge/users.json` (shields.io odznak). Predvolene vypnuté. |
| `EXTRA_REDIRECT_URIS` | nie | Ďalšie presné OAuth redirect URI oddelené medzerou. |
| `MAX_FAILED_LOGINS_PER_HOUR` | nie | Celkový strop neúspešných prihlásení za hodinu (predvolene 60). |
| `TRUST_PROXY_HOPS` | nie | Počet proxy pred aplikáciou (predvolene 1). |
| `HOST`, `PORT`, `STATE_DIR` | nie | Kde aplikácia počúva (`127.0.0.1:8092`) a kam ukladá stav (`./data`). |

`CREDENTIALS_KEY` a priečinok so stavom (`STATE_DIR`) sú jediné dve veci, ktoré treba chrániť a zálohovať.

## Variant A: Docker + Caddy

Najjednoduchší spôsob na čistom stroji. Caddy si sám vybaví a obnovuje HTTPS certifikát.

```bash
git clone https://github.com/MarosMacko/kt-mcp-multiuser.git && cd kt-mcp-multiuser
cp .env.example .env
```

V `.env` vyplň:

```ini
KT_DOMAIN=kt.example.com
CREDENTIALS_KEY=<výstup príkazu: openssl rand -base64 32>
OPERATOR_NAME=Tvoje meno
OPERATOR_CONTACT=ty@example.com
```

(`PUBLIC_URL`, `HOST`, `PORT` a `STATE_DIR` v `.env` pri Dockeri nechaj tak, compose ich nastaví sám.)

Spusti a over:

```bash
BUILD_COMMIT=$(git rev-parse --short HEAD) docker compose up -d --build
docker compose logs -f kt-mcp        # „kt-mcp 0.3.0 (a1b2c3d) listening on 0.0.0.0:8092“
./scripts/verify-deployment.sh https://kt.example.com
```

Aktualizácia: `git pull && BUILD_COMMIT=$(git rev-parse --short HEAD) docker compose up -d --build`. Stav je vo volume
`kt-mcp-state`, redeploy nikoho neodpojí. `BUILD_COMMIT` len označí verziu v pätičke stránok a v `/healthz`; bez neho
sa zobrazí verzia bez commitu.

## Variant B: systemd + existujúca reverzná proxy

Na VPS, kde už beží Caddy alebo nginx. Tento variant používa aj kt.marosm.com.

**Jednorazová príprava** (Ubuntu/Debian, ako používateľ so sudo):

```bash
# Node.js 22+ (napr. z NodeSource) a rsync
sudo useradd --system --no-create-home --shell /usr/sbin/nologin kt-mcp
sudo install -d -m 0700 -o root -g root /etc/kt-mcp
sudo cp .env.example /etc/kt-mcp/kt-mcp.env && sudo chmod 600 /etc/kt-mcp/kt-mcp.env
sudoedit /etc/kt-mcp/kt-mcp.env     # PUBLIC_URL, CREDENTIALS_KEY, OPERATOR_*; zmaž riadky KT_DOMAIN a STATE_DIR
sudo cp deploy/systemd/kt-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable kt-mcp
```

`/etc/kt-mcp/kt-mcp.env` číta systemd ešte ako root, takže súbor môže zostať čitateľný len pre roota. Stav ukladá
služba do `/var/lib/kt-mcp` (nastavené v unite).

**Nasadenie a každá ďalšia aktualizácia** (z priečinka repozitára):

```bash
./deploy/systemd/deploy.sh    # npm ci, testy, build, inštalácia do /opt/kt-mcp, reštart
```

**Reverzná proxy.** Pre Caddy pridaj blok z [`deploy/systemd/Caddyfile.example`](../deploy/systemd/Caddyfile.example)
a `sudo systemctl reload caddy`. Pre nginx (certifikát cez certbot) zhruba:

```nginx
server {
    server_name kt.example.com;
    listen 443 ssl;   # + certbot riadky
    access_log off;
    client_max_body_size 1m;
    location / {
        proxy_pass http://127.0.0.1:8092;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;   # PREPÍSAŤ, nie pridať (pozri nižšie)
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;                             # MCP odpovede sa streamujú
        proxy_read_timeout 300s;
    }
}
```

Na čo si dať pozor pri proxy:

- **`X-Forwarded-For` musí proxy prepísať skutočnou IP klienta**, nie k nej pridať hodnotu od klienta. Inak si útočník
  pri každom pokuse vymyslí novú IP a obmedzenie prihlasovania prestane fungovať. Caddy to robí sám; v nginx použi
  `$remote_addr`, nie `$proxy_add_x_forwarded_for`.
- **Bez bufferovania** (`proxy_buffering off`), inak sa volania nástrojov zasekávajú.
- **Bez prístupových logov**, ak nechceš uchovávať IP adresy používateľov (Caddy bez `log` direktívy, nginx `access_log off`).
- Bezpečnostné hlavičky (CSP a ďalšie) posiela aplikácia sama; v proxy pre stránky servera nenastavuj ďalšie CSP,
  inak môže zablokovať návrat z prihlásenia do lokálnych aplikácií.

**Za Cloudflare Tunnel:** nasmeruj tunel na Caddy alebo nginx a v proxy nastav `X-Forwarded-For` na hodnotu hlavičky
`CF-Connecting-IP` (Cloudflare ju vždy prepisuje), napr. v nginx `proxy_set_header X-Forwarded-For $http_cf_connecting_ip;`.

## Overenie

```bash
./scripts/verify-deployment.sh https://kt.example.com   # dostupnosť, PUBLIC_URL, OAuth discovery, 401 bez tokenu
./scripts/security-audit.sh https://kt.example.com      # pokusy dostať sa k nástrojom bez prihlásenia
```

Potom pridaj `https://kt.example.com/mcp` ako konektor v Claude/ChatGPT a prihlás sa.

## Kto môže server používať

**Ktokoľvek** (predvolené): každý s účtom v Kalorických tabuľkách (.sk aj .cz). Ochranu zabezpečujú limity prihlasovania,
šifrovanie a obmedzenie návratových adries klientov. Ak server púšťaš cudzím ľuďom, vyplň `OPERATOR_NAME`
a `OPERATOR_CONTACT` a prečítaj si časť [Prevádzka pre iných](#prevádzka-pre-iných).

**Len vybraní ľudia:** vytvor súbor s e-mailmi a nastav naň `ALLOWED_USERS_FILE`:

```bash
printf '%s\n' '# kto môže používať server' ja@example.com mama@example.com | sudo tee /etc/kt-mcp/allowed-users
sudo chown root:kt-mcp /etc/kt-mcp/allowed-users && sudo chmod 640 /etc/kt-mcp/allowed-users
# v kt-mcp.env: ALLOWED_USERS_FILE=/etc/kt-mcp/allowed-users, potom sudo systemctl restart kt-mcp
```

Zmeny v súbore platia hneď. Odobratý e-mail stratí prístup pri ďalšej požiadavke a server zmaže jeho uložené prihlásenie.
(V Dockeri súbor pripoj ako volume a cestu nastav v `.env`.)

**Len cez Claude a ChatGPT** (bez lokálnych klientov): nastav `ALLOW_LOCAL_CLIENTS=false`. Ak chceš navyše, aby sa
k serveru okrem prihlasovacích stránok nedostal nikto iný než servery Anthropic a OpenAI, použi Caddy blok
z [`deploy/extras/hosted-clients-only/`](../deploy/extras/hosted-clients-only/) aj s časovačom, ktorý každých
6 hodín obnovuje zoznam IP adries ChatGPT. Claude aj ChatGPT na mobile fungujú ďalej, lebo idú cez tieto servery.

## Prevádzka pre iných

Ak server používajú iní ľudia, spracúvaš ich osobné údaje (e-mail, prístup k jedálničku, teda aj údaje o zdraví).
Server je navrhnutý tak, aby toho bolo čo najmenej:

- na disku sú len hashe tokenov, HMAC e-mailov a prihlásenia zašifrované kľúčom, ktorý bez tokenu nevznikne;
- jedálniček sa neukladá, do logov sa nezapisujú e-maily ani obsah volaní;
- po 60 dňoch nečinnosti sa všetko o účte zmaže samo; používateľ sa môže kedykoľvek odpojiť sám (`/forget`
  alebo nástroj `disconnect_account`);
- stránka `/privacy` to vysvetľuje po slovensky a uvádza tvoj kontakt z `OPERATOR_*`.

Na tebe zostáva: vyplniť kontakt, nevypínať tieto vlastnosti, nezapínať prístupové logy s IP adresami (alebo ich
držať krátko) a na požiadanie vymazať údaje (stačí, keď človek použije `/forget`). Podmienky Dine4Fit dávajú
používateľom osobnú, nekomerčnú licenciu; službu preto neprevádzkuj za peniaze.

## Zálohy, kľúč, zmena domény

- **Zálohuj** `CREDENTIALS_KEY` (oddelene) a stavový súbor `oauth-state.json`. Ani jedno samo osebe nič neprezradí.
  Keď stratíš stav alebo kľúč, nič sa nepokazí, len sa všetci musia prihlásiť znova.
- **Zmena kľúča** = všetci sa prihlásia znova. Použi ju, ak máš podozrenie, že kľúč unikol.
- **Zmena domény:** uprav `PUBLIC_URL`/`KT_DOMAIN`, reštartuj a v aplikáciách konektor odober a pridaj s novou adresou.
  Tokeny sú viazané na pôvodnú adresu, takže staré prestanú platiť.

## Riešenie problémov

| Príznak | Príčina |
|---|---|
| `verify-deployment.sh`: PUBLIC_URL mismatch | `PUBLIC_URL` nesedí s doménou, na ktorú sa pripájaš. |
| Prihlásenie hlási „kaloricketabulky.sk/.cz odmietli prihlásenie“ | Zlé heslo, účet je na druhej stránke (.sk a .cz majú oddelené účty), alebo sa heslom nedá prihlásiť priamo na webe (účet len cez Google/Facebook: na webe si heslo nastav). |
| „Príliš veľa pokusov“ | 5 neúspešných pokusov za 15 minút z IP alebo na účet; počkaj. Ak to hlási všetkým, prekročil sa `MAX_FAILED_LOGINS_PER_HOUR`. |
| Claude Code / VS Code: registrácia klienta zlyhá | `ALLOW_LOCAL_CLIENTS=false`, alebo klient používa vlastnú schému: pridaj jeho redirect URI do `EXTRA_REDIRECT_URIS`. |
| Volania nástrojov visia | Proxy bufferuje odpovede (`proxy_buffering off`). |
| Po aktualizácii sa všetci musia prihlásiť | Zmenil sa `CREDENTIALS_KEY`, `PUBLIC_URL`, alebo sa stratil `STATE_DIR` (volume/`/var/lib/kt-mcp`). |

Logy: `docker compose logs kt-mcp` alebo `journalctl -u kt-mcp`.
