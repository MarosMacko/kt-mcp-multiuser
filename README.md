# kt-mcp: Kalorické tabuľky pre AI asistenta

[MCP](https://modelcontextprotocol.io) server, ktorý prepojí AI asistenta (Claude, ChatGPT, Claude Code, VS Code…)
s tvojím jedálničkom na **kaloricketabulky.sk** alebo **kaloricketabulky.cz**.

Povieš *„na raňajky som mal rožok so šunkou a dve vajcia“* a asistent vyhľadá potraviny v databáze, vyberie
správne porcie a zapíše ich do tvojho skutočného jedálnička. Oficiálna aplikácia zostáva zdrojom pravdy, takže
prémiové funkcie fungujú ďalej.

> Neoficiálny projekt, nie je od Dine4Fit, a.s. (prevádzkovateľa Kalorických tabuliek).

## Rýchly štart: hotový server

Na **https://kt.marosm.com** beží verejná inštancia, ktorú môže zadarmo používať ktokoľvek s účtom na
Kalorických tabuľkách (.sk alebo .cz). Je bez záruky: keď sa niečo pokazí, môže chvíľu nefungovať.

Adresa konektora: **`https://kt.marosm.com/mcp`**

| Aplikácia | Ako pridať |
|---|---|
| **Claude** (web, desktop, mobil) | Nastavenia → Konektory → Pridať vlastný konektor (*Settings → Connectors → Add custom connector*), vlož adresu. Na mobile sa konektor objaví sám po pridaní na webe. |
| **ChatGPT** | Nastavenia → Aplikácie a konektory → Vytvoriť (vyžaduje zapnutý vývojársky režim). |
| **Claude Code** | `claude mcp add --transport http kaloricke-tabulky https://kt.marosm.com/mcp`, potom v Claude Code `/mcp` → prihlásiť. |
| **VS Code, Cursor, iné** | Pridaj vzdialený MCP server typu HTTP s adresou vyššie. |

Pri pridaní sa otvorí prihlasovacia stránka servera. Vyber, kde máš účet (**kaloricketabulky.sk** alebo
**kaloricketabulky.cz**, účty sú oddelené), a zadaj e-mail a heslo z tej stránky. Viac nie je treba, žiadna ďalšia
registrácia.

Ako sa zaobchádza s údajmi: [kt.marosm.com/privacy](https://kt.marosm.com/privacy). Odpojenie a zmazanie:
povedz asistentovi *„odpoj môj účet Kalorických tabuliek“*, alebo použi [kt.marosm.com/forget](https://kt.marosm.com/forget).

Nechceš svoje prihlásenie zveriť cudziemu serveru? Spusti si vlastný, pozri [Vlastný server](#vlastný-server).

## Čo sa dá robiť

Nie je to len rýchlejšie zapisovanie. Asistent vidí tvoj jedálniček aj ciele, ktoré máš nastavené v profile
(kalórie, bielkoviny, sacharidy, tuky, vláknina, pitný režim, váha), takže sa ho môžeš pýtať ako výživového poradcu.
Nič z toho netreba nastavovať, stačí písať.

**Zapisovanie bez klikania**

- **Hovorom.** *„K obedu som mal 200 g kuracích pŕs a ryžu.“* Asistent nájde potraviny, zvolí prirodzené porcie
  (*kus (55 g)* namiesto odhadovaných gramov) a zapíše každú položku do správneho jedla dňa.
- **Fotkou z reštaurácie.** Odfoť tanier a napíš *„zapíš mi to ako večeru“*. Asistent rozpozná jedlo, odhadne
  gramáže, ukáže ti odhad a po potvrdení zapíše. Funguje aj *„toto som mal včera na obed“*.
- **Fotkou etikety alebo receptu.** Z etikety prečíta nutričné hodnoty, z receptu suroviny a na *„ulož mi to ako
  jedlo“* vytvorí uložený recept, ktorý nabudúce zapíšeš jedným záznamom.
- **Opravy a kopírovanie.** *„Tú ryžu oprav na 150 g“*, *„zmaž poslednú položku“*, *„skopíruj mi včerajšie raňajky
  na dnes“*.
- **Pohyb a váha.** *„Ráno som išiel 40 minút rýchlou chôdzou“*, *„dnes vážim 82,4“*.
- **Rutina.** Ak asistent vie plánované úlohy: *„Každý deň o 9:00 mi zapíš dve espressá s mliekom.“*

**Rady podľa tvojich cieľov**

- **Čo ešte zjesť dnes.** *„Koľko mi dnes zostáva kalórií a bielkovín? Navrhni večeru, ktorá to dorovná.“*
- **Pred jedlom.** *„Som v reštaurácii, tu je menu (fotka). Čo si mám dať, aby som sa zmestil do dnešných cieľov?“*
- **Plán na zajtra alebo týždeň.** *„Navrhni mi jedálniček na zajtra podľa mojich cieľov, z jedál, ktoré bežne jem.“*
  Asistent si vie prečítať tvoje obľúbené a najčastejšie potraviny aj uložené recepty a stavať z nich.

**Prehľady, trendy a odporúčania z histórie**

- **Týždeň a mesiac.** *„Ako mi išiel tento týždeň?“*, *„porovnaj posledné dva týždne“*, *„v ktoré dni prekračujem
  kalórie?“*
- **Vzorce v jedle.** *„Kde mi chýbajú bielkoviny?“*, *„v ktoré dni mám priveľa cukru alebo soli?“*,
  *„z čoho mám najviac kalórií?“*
- **Návrhy zmien.** *„Pozri sa na posledný mesiac a navrhni tri konkrétne zmeny, aby som schudol pol kila týždenne.“*
  *„Je môj cieľ kalórií realistický vzhľadom na to, ako mi ide váha?“*
- **Ráno alebo večer zhrnutie.** Ak asistent vie plánované úlohy: *„Každý večer o 21:00 mi zhrň deň a povedz, čo
  zajtra urobiť inak.“*

Asistent je tak dobrý, ako dobré sú dáta: čím poctivejšie zapisuješ, tým lepšie rady. Rady o výžive nie sú
lekárske odporúčanie.

## Nástroje

| Nástroj | Účel |
|---|---|
| `search_food` | Nájde potraviny podľa názvu (slovensky alebo česky) alebo EAN kódu. Vracia id, ktoré potrebujú ostatné nástroje. |
| `get_food_portions` | Prirodzené porcie potraviny (`kus (55 g)`), aby sa „3 vajcia“ zapísali ako tri kusy. |
| `get_food_nutrition` | Kalórie a makrá pre dané množstvo, prepočítané samotným webom. |
| `log_food` | Zapíše potravinu do jedálnička. |
| `log_own_food` | Zapíše jedlo, ktoré v databáze nie je, s vlastnými hodnotami (napr. z etikety). |
| `get_day_entries` | Všetky záznamy dňa s id, množstvom a kalóriami. |
| `edit_diary_entry` | Zmení množstvo či jednotku, dĺžku aktivity, alebo presunie jedlo do iného jedla dňa. |
| `delete_diary_entry` | Zmaže jeden záznam. |
| `copy_meal` | Skopíruje jedlo (napr. včerajšie raňajky) na iný deň alebo do iného jedla dňa. |
| `add_note` | Pridá poznámku k dňu alebo k jedlu. |
| `get_day_summary` | Denné súčty. |
| `get_day_progress` | Deň oproti cieľom z webu: energia, makrá, sledované živiny, pitný režim, váha. |
| `get_period_overview` | Prehľad za viac dní (predvolene týždeň) po dňoch aj v priemere. |
| `create_meal` / `list_my_meals` / `log_meal` / `delete_meal` | Uložené recepty: vytvoriť, vypísať, zapísať, zmazať. |
| `list_templates` / `create_template` / `apply_template` / `delete_template` | Uložené jedálničky celých dní. |
| `get_usual_items` / `set_favorite` | Obľúbené a najpoužívanejšie potraviny a aktivity. |
| `search_activity` / `log_activity` / `log_custom_activity` | Aktivity: vyhľadať, zapísať na minúty, alebo so známymi kalóriami (z hodiniek). |
| `log_weight` | Zapíše váhu k danému dňu. |
| `disconnect_account` | Odpojí účet od servera a zmaže všetko, čo o ňom server má. |

Množstvo pri `log_food` a `create_meal` počíta **jednotky**, nie gramy: bez `unit_id` sa použije základná jednotka
potraviny (gramy, pri nápojoch mililitre), s `unit_id` z `get_food_portions` sa porcia násobí (2 × `porcia (250 ml)` = 500 ml).

## Bezpečnosť a súkromie

Ako funguje prihlásenie:

1. Prihlasovaciu stránku otvára tvoj prehliadač priamo na serveri. AI asistent tvoje heslo nikdy nevidí.
2. Server z hesla spraví MD5 odtlačok. Presne ten posiela pri prihlásení aj samotný web Kalorických tabuliek;
   heslo v čitateľnej podobe sa nikam neukladá.
3. Prihlásenie overí priamo v Kalorických tabuľkách; vlastnú databázu hesiel nemá.
4. Vydá AI asistentovi náhodný prístupový token (OAuth 2.1 + PKCE). Pri každom tokene uloží tvoj e-mail a odtlačok
   **zašifrovaný kľúčom odvodeným zo serverového tajomstva a z tohto tokenu**. Samotný token je uložený len ako hash.

Čo z toho vyplýva:

- Ukradnutý súbor so stavom servera je bezcenný, aj keby mal útočník k nemu serverový kľúč: bez platného tokenu, ktorý
  má len tvoj asistent, sa nedá nič dešifrovať. E-maily v ňom nie sú v čitateľnej podobe.
- Jedálniček, váha ani aktivity sa na serveri neukladajú, len prechádzajú. Do logov sa nezapisujú ani e-maily,
  ani obsah volaní.
- MD5 odtlačok ale na prihlásenie do Kalorických tabuliek stačí a dá sa z neho spätne uhádnuť slabé heslo.
  **V Kalorických tabuľkách používaj heslo, ktoré nemáš nikde inde.** Zmena hesla na webe okamžite zneplatní všetko,
  čo má server uložené.
- Prístupové tokeny platia 7 dní a obnovujú sa; po 60 dňoch nečinnosti sa všetko o účte zmaže automaticky.
- Prihlasovanie je obmedzené (5 neúspešných pokusov na IP aj na účet za 15 minút, celkový strop za hodinu), aby sa
  server nedal použiť na skúšanie ukradnutých hesiel.
- Registrovať sa môžu len klienti s návratovou adresou Claude, ChatGPT alebo localhost (lokálne aplikácie). Stránka
  podobná prihlasovacej teda nemôže poslať tvoj prístup na cudzí web.

## Vlastný server

Server je malý (Node.js, jeden proces, stav v jednom JSON súbore). Potrebuješ stroj, ktorý beží nepretržite,
doménu a otvorené porty 80/443. Najkratšia cesta s Dockerom:

```bash
git clone https://github.com/MarosMacko/kt-mcp.git kt-mcp && cd kt-mcp
cp .env.example .env
# v .env vyplň KT_DOMAIN, CREDENTIALS_KEY (openssl rand -base64 32), OPERATOR_NAME, OPERATOR_CONTACT
docker compose up -d --build
./scripts/verify-deployment.sh https://<tvoja-doména>
```

Podrobný návod (Docker, systemd s existujúcim Caddy/nginx, obmedzenie na zoznam ľudí alebo len na Claude/ChatGPT,
zálohy, aktualizácie, riešenie problémov): **[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)**.
Nasadzuješ to cez AI agenta? Ten nájde postup v [AGENTS.md](AGENTS.md).

## Ako to funguje

kaloricketabulky.cz a kaloricketabulky.sk bežia na tej istej Spring MVC aplikácii a databáze potravín (rovnaké id
potravín), ale **účty majú oddelené**: prihlásenie platí len na stránke, kde bol účet založený. Doména určuje aj jazyk
názvov. Každá cesta odpovie aj v JSON, keď pridáš `?format=json`.
Server si pri každom používateľovi pamätá, na ktorú doménu sa má obracať.
Celá mapa endpointov je v [`src/kt/client.ts`](src/kt/client.ts).

```
AI asistent ──OAuth 2.1 + MCP/HTTPS──► kt-mcp ──JSESSIONID──► kaloricketabulky.sk / .cz
```

| Cesta | Účel |
|---|---|
| `POST /mcp` | MCP endpoint (vyžaduje bearer token) |
| `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server` | OAuth discovery (RFC 9728, RFC 8414) |
| `/authorize`, `/token`, `/register`, `/revoke` | OAuth: authorization code + PKCE, dynamická registrácia klientov, rotácia refresh tokenov |
| `/`, `/privacy`, `/forget` | Úvodná stránka, ochrana súkromia, odpojenie účtu |
| `/healthz` | Kontrola, že server beží |

```
src/
  index.ts          štart: načíta konfiguráciu a spustí server
  config.ts         všetky premenné prostredia (pozri .env.example)
  app.ts            Express: MCP endpoint, OAuth, stránky
  auth/provider.ts  OAuth server: tokeny, prihlásenie, odpojenie, migrácia stavu
  auth/users.ts     allowlist, šifrovanie, odvodzovanie kľúčov, limity prihlasovania
  auth/store.ts     JSON súbor so stavom
  kt/client.ts      klient pre kaloricketabulky.sk / .cz
  mcp/tools.ts      MCP nástroje
  web/pages.ts      HTML stránky (slovensky)
deploy/             príklady nasadenia: docker/, systemd/, extras/
scripts/            overenie nasadenia, bezpečnostný audit, end-to-end test
```

## Obmedzenia

- **Nedokumentovaný web.** Zmena na strane Dine4Fit môže čokoľvek rozbiť. Klient pri neočakávanej odpovedi radšej
  vyhodí chybu, než by zapísal zlý počet kalórií.
- **Časť porcie receptu sa zapísať nedá.** Web vždy zapíše celý recept. Keď si zjedol len časť, zapíš suroviny jednotlivo.
- **Jedna inštancia na jeden stavový súbor.** Server nie je stavaný na viac replík naraz.

## Vývoj

```bash
npm install
npm test               # build + unit testy
npm run e2e            # prihlasovací tok end-to-end (prihlásenie je simulované, vyhľadávanie ide na skutočný web)
```

Lokálne spustenie: vyplň `.env` (aspoň `PUBLIC_URL` a `CREDENTIALS_KEY`), potom `set -a; source .env; set +a; npm start`.
`GET /healthz` vypíše, akú adresu MCP endpointu server hlási.

## Pôvod projektu

Projekt vychádza z [stany9g/kt-mcp](https://github.com/stany9g/kt-mcp) (MIT) cez forky
[honzajscz/kt-mcp](https://github.com/honzajscz/kt-mcp) a [LukasFoukal/kt-mcp](https://github.com/LukasFoukal/kt-mcp),
od ktorých preberá klienta pre Kalorické tabuľky a väčšinu nástrojov. Táto verzia pridáva viac používateľov na
jednom serveri s prihlásením vlastným účtom, šifrovanie viazané na token, podporu ChatGPT a lokálnych MCP klientov,
podporu kaloricketabulky.sk, stránky pre ochranu súkromia a odpojenie a zjednodušené nasadenie. Vďaka pôvodným autorom.

## Licencia

[MIT](LICENSE). Databáza potravín a služba Kalorické tabuľky patria Dine4Fit, a.s.; licencia pokrýva len kód
v tomto repozitári.
