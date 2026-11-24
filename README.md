# kt-mcp-multiuser: Kalorické tabuľky pre AI asistenta

[MCP](https://modelcontextprotocol.io) server, ktorý prepojí AI asistenta (Claude, ChatGPT, Claude Code, VS Code…)
s tvojím jedálničkom na **kaloricketabulky.sk** alebo **kaloricketabulky.cz**.

Povieš *„na raňajky som mal rožok so šunkou a dve vajcia“* a asistent vyhľadá potraviny v databáze, vyberie
správne porcie a zapíše ich do tvojho skutočného jedálnička. Oficiálna aplikácia zostáva zdrojom pravdy, takže
prémiové funkcie fungujú ďalej.

> Neoficiálny projekt, nie je od Dine4Fit, a.s. (prevádzkovateľa Kalorických tabuliek).

## Čím sa líši od pôvodného kt-mcp

Je to fork [kt-mcp](https://github.com/stany9g/kt-mcp) (cez [honzajscz](https://github.com/honzajscz/kt-mcp) a
[LukasFoukal](https://github.com/LukasFoukal/kt-mcp), [pôvod](#pôvod-projektu)). Pôvodný server patrí jednému
človeku, ktorého prihlasovacie údaje sú v konfigurácii. Táto verzia pridáva:

- **Viac ľudí na jednom serveri.** Každý sa prihlási vlastným účtom Kalorických tabuliek, prevádzkovateľ nič
  nenastavuje. Beží verejne na kt.marosm.com.
- **Bezpečnosť a súkromie.** Prihlasovacie údaje šifrované kľúčom viazaným na token, v stave servera žiadne čitateľné
  e-maily, obmedzenie pokusov o prihlásenie, stránky na ochranu súkromia a odpojenie účtu.
- **Viac stránok a klientov.** kaloricketabulky.sk popri .cz (oddelené účty) a ChatGPT, Claude Code či VS Code
  popri Claude.
- **Analýzy z jedálnička.** Makrá pri každej položke, všetky položky za až 31 dní, prehľad až 92 dní s označením
  neúplných dní, spálené kalórie aj z tréningov z hodiniek, bazálny metabolizmus a koeficient aktivity.
- **Menej chýb pri zapisovaní.** Recepty po porciách s kontrolou, čo web naozaj zapísal, ochrana pred dvojitým
  zápisom tréningu z hodiniek, vyhľadávanie, ktoré nájde aj *„skyr natur 42 g bílkovin“*.
- **Slovenská dokumentácia a jednoduché nasadenie** (Docker Compose s Caddy alebo systemd) s návodom aj pre AI agentov.

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
- **Jedlo z donášky.** *„Tu je menu z Woltu (odkaz). Čo si dať, aby som dorovnal bielkoviny a vlákninu? Potom to
  zapíš.“* Čo v databáze nie je, zapíše s odhadnutými hodnotami, a keď to ješ častejšie, uloží to ako recept.
- **Varenie do zásoby.** *„Uvaril som lasagne na 8 porcií, zapíš mi jednu na obed.“* Recept sa zapisuje po porciách.
- **Opravy a kopírovanie.** *„Tú ryžu oprav na 150 g“*, *„zmaž poslednú položku“*, *„skopíruj mi včerajšie raňajky
  na dnes“*.
- **Pohyb a váha.** *„Ráno som išiel 40 minút rýchlou chôdzou“*, *„dnes vážim 82,4“*. Ak máš hodinky (Garmin a pod.)
  prepojené s Kalorickými tabuľkami, tréningy sa do jedálnička dostanú samy a asistent ich druhýkrát nezapíše.
- **Pitný režim.** *„Zapíš pol litra vody“*, *„k obedu som mal čaj“*. Zapísané nápoje sa rátajú do cieľa pitného režimu.
- **Rutina.** Ak asistent vie plánované úlohy: *„Každý deň o 9:00 mi zapíš dve espressá s mliekom.“*

**Rady podľa tvojich cieľov**

- **Čo ešte zjesť dnes.** *„Koľko mi dnes zostáva kalórií a bielkovín? Navrhni večeru, ktorá to dorovná.“*
- **Pred jedlom.** *„Som v reštaurácii, tu je menu (fotka). Čo si mám dať, aby som sa zmestil do dnešných cieľov?“*
- **Tréningový deň.** *„Večer mám beh 60 minút, čo zjesť pred a po?“* Asistent vidí, koľko si už zjedol, aj tréningy
  z hodiniek.
- **Plán na zajtra alebo týždeň.** *„Navrhni mi jedálniček na zajtra podľa mojich cieľov, z jedál, ktoré bežne jem.“*
  Asistent si vie prečítať tvoje obľúbené a najčastejšie potraviny aj uložené recepty a stavať z nich.

**Prehľady, trendy a odporúčania z histórie**

- **Týždeň až štvrťrok.** *„Ako mi išiel tento týždeň? Ktoré dni sú neúplné?“*, *„porovnaj posledné dva mesiace“*,
  *„v ktoré dni prekračujem kalórie?“* Dni, keď si zabudol zapisovať, asistent označí a nepočíta ich ako dni hladovky.
- **Vzorce v jedle.** *„Kde mi chýbajú bielkoviny?“*, *„z čoho mám dnes najviac tuku?“*, *„čo mi za mesiac dodáva
  najviac cukru?“* Asistent vidí makrá pri každej položke.
- **Výsledky z krvi.** *„Tu sú moje výsledky krvi, porovnaj ich s jedálničkom za posledný mesiac.“* Asistent prejde
  každú položku za až 31 dní aj s gramážou a makrami.
- **Návrhy zmien.** *„Pozri sa na posledný mesiac a navrhni tri konkrétne zmeny, aby som schudol pol kila týždenne.“*
  *„Je cieľ 2500 kcal správny, keď mi váha ide hore?“* Asistent pozná aj tvoj bazálny metabolizmus, ako ho počíta web.
- **Ráno alebo večer zhrnutie.** Ak asistent vie plánované úlohy: *„Každý večer o 21:00 mi zhrň deň a povedz, čo
  zajtra urobiť inak.“*

Asistent je tak dobrý, ako dobré sú dáta: čím poctivejšie zapisuješ, tým lepšie rady. Rady o výžive nie sú
lekárske odporúčanie.

## Nástroje

| Nástroj | Účel |
|---|---|
| `search_food` | Nájde potraviny podľa názvu (slovensky alebo česky) alebo EAN kódu, na požiadanie aj s makrami na 100 g. Vracia id, ktoré potrebujú ostatné nástroje. |
| `get_food_portions` | Prirodzené porcie potraviny (`kus (55 g)`), aby sa „3 vajcia“ zapísali ako tri kusy. |
| `get_food_nutrition` | Kalórie, makrá a ďalšie živiny (vápnik, cholesterol…) pre dané množstvo, prepočítané samotným webom. |
| `log_food` | Zapíše potravinu do jedálnička. |
| `log_own_food` | Zapíše jedlo, ktoré v databáze nie je, s vlastnými hodnotami (napr. z etikety). |
| `get_day_entries` | Všetky záznamy dňa s id, množstvom v gramoch a makrami pri každej položke. |
| `get_entries_range` | Všetky položky za až 31 dní s gramážou a makrami, plus súhrn podľa potraviny. |
| `edit_diary_entry` | Zmení množstvo či jednotku, dĺžku aktivity, alebo presunie jedlo do iného jedla dňa. |
| `delete_diary_entry` | Zmaže jeden záznam. |
| `copy_meal` | Skopíruje jedlo (napr. včerajšie raňajky) na iný deň alebo do iného jedla dňa. |
| `add_note` | Pridá poznámku k dňu alebo k jedlu. |
| `get_day_summary` | Energia dňa, bazálny metabolizmus a koeficient aktivity podľa webu, BMI. |
| `get_day_progress` | Deň oproti cieľom z webu: energia (zjedené, spálené, netto), makrá, sledované živiny, pitný režim, váha. |
| `get_period_overview` | Prehľad za až 92 dní po dňoch aj v priemere, s označením neúplných dní. |
| `create_meal` / `list_my_meals` / `log_meal` / `delete_meal` | Uložené recepty: vytvoriť, vypísať, zapísať (po porciách), zmazať. |
| `list_templates` / `create_template` / `apply_template` / `delete_template` | Uložené jedálničky celých dní. |
| `get_usual_items` / `set_favorite` | Obľúbené a najpoužívanejšie potraviny a aktivity. |
| `search_activity` / `log_activity` / `log_custom_activity` | Aktivity: vyhľadať, zapísať na minúty, alebo so známymi kalóriami (z hodiniek). Podobne dlhý tréning, ktorý už v ten deň je, nezapíše druhýkrát. |
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
git clone https://github.com/MarosMacko/kt-mcp-multiuser.git && cd kt-mcp-multiuser
cp .env.example .env
# v .env vyplň KT_DOMAIN, CREDENTIALS_KEY (openssl rand -base64 32), OPERATOR_NAME, OPERATOR_CONTACT
BUILD_COMMIT=$(git rev-parse --short HEAD) docker compose up -d --build
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
| `/healthz` | Kontrola, že server beží, a jeho verzia s commitom |

```
src/
  index.ts          štart: načíta konfiguráciu a spustí server
  config.ts         všetky premenné prostredia (pozri .env.example)
  app.ts            Express: MCP endpoint, OAuth, stránky
  auth/provider.ts  OAuth server: tokeny, prihlásenie, odpojenie, migrácia stavu
  auth/users.ts     allowlist, šifrovanie, odvodzovanie kľúčov, limity prihlasovania
  auth/store.ts     JSON súbor so stavom
  kt/client.ts      klient pre kaloricketabulky.sk / .cz
  kt/derive.ts      prevod údajov webu na čísla (množstvá, súhrny, neúplné dni)
  mcp/tools.ts      MCP nástroje a pokyny pre AI asistenta
  web/pages.ts      HTML stránky (slovensky)
deploy/             príklady nasadenia: docker/, systemd/, extras/
scripts/            overenie nasadenia, bezpečnostný audit, end-to-end test
```

## Obmedzenia

- **Nedokumentovaný web.** Zmena na strane Dine4Fit môže čokoľvek rozbiť. Klient pri neočakávanej odpovedi radšej
  vyhodí chybu, než by zapísal zlý počet kalórií.
- **Recepty po porciách.** Recept sa zapisuje počtom porcií. Server po zápise prečíta, koľko kalórií web naozaj
  zapísal, a keď to nesedí s porciami, asistent ťa upozorní.
- **Len 12 mesiacov dozadu.** Staršie dni web na zápis nepustí, čítať sa dajú.
- **Vitamíny a minerály bez množstiev.** Web pri potravinách uvádza len, ktoré vitamíny a minerály obsahujú. Množstvo
  má len pri vápniku a cholesterole, ostatné asistent odhadne.
- **Recept ani vlastnú potravinu nejde upraviť cez asistenta.** Upraviť ich vieš na webe, alebo cez asistenta zmazať a
  vytvoriť znova.
- **Jedna inštancia na jeden stavový súbor.** Server nie je stavaný na viac replík naraz.

## Vývoj

```bash
npm install
npm test               # build + unit testy
npm run e2e            # prihlasovací tok end-to-end (prihlásenie je simulované, vyhľadávanie ide na skutočný web)
```

Lokálne spustenie: vyplň `.env` (aspoň `PUBLIC_URL` a `CREDENTIALS_KEY`), potom `set -a; source .env; set +a; npm start`.
`GET /healthz` vypíše, akú adresu MCP endpointu server hlási, a verziu.

**Verzia.** Jediné miesto, kde sa verzia píše, je `version` v `package.json`. `npm run build` k nej pridá skrátený
commit (z gitu, v Dockeri z `BUILD_COMMIT`). Zobrazuje sa v pätičke každej stránky (*verzia 0.3.0 (a1b2c3d)*),
v `/healthz`, v informáciách o MCP serveri a v logu pri štarte, takže je vidno, ktorá kópia projektu kde beží.
Ak build vznikol z necommitnutých zmien, git to pri builde zistí sám a k verzii pribudne *upravená*. Netreba nič
robiť ručne: po commite a novom builde zmizne. Pri Docker builde s `BUILD_COMMIT` sa to zistiť nedá (obraz nemá
`.git`), takže sa tam nezobrazuje. Pri vydaní novej verzie zvýš číslo v `package.json` (aj `npm install`
ho prepíše do `package-lock.json`).

## Pôvod projektu

Projekt vychádza z [stany9g/kt-mcp](https://github.com/stany9g/kt-mcp) (MIT) cez forky
[honzajscz/kt-mcp](https://github.com/honzajscz/kt-mcp) a [LukasFoukal/kt-mcp](https://github.com/LukasFoukal/kt-mcp),
od ktorých preberá klienta pre Kalorické tabuľky a väčšinu nástrojov na zapisovanie. Čo pridáva táto verzia, je
v časti [Čím sa líši od pôvodného kt-mcp](#čím-sa-líši-od-pôvodného-kt-mcp). Vďaka pôvodným autorom.

## Licencia

[MIT](LICENSE). Databáza potravín a služba Kalorické tabuľky patria Dine4Fit, a.s.; licencia pokrýva len kód
v tomto repozitári.
