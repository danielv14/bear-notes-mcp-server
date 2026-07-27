---
name: bear-protocol
description: Kör end-to-end-protokollet för den här MCP-servern mot den riktiga Bear-appen. Skapar, läser, moddar, taggar, arkiverar och slänger en riktig testanteckning via de anslutna bear-verktygen och verifierar varje write med en rå sqlite3-fråga. Använd vid "bear-protocol", "kör protokollet", "e2e-testa bear", "verifiera mot riktiga Bear", "end to end test", innan merge av ändringar i läsfrågor, skrivvägen, verktygsytan eller note-renderingen.
---

# Bear end-to-end protocol

Källan är [docs/TEST-PROTOCOL.md](../../../docs/TEST-PROTOCOL.md). Den här
skillen kör den, den ersätter den inte. Läs hela protokollfilen först och följ
den, inklusive dess ground rules, check-id:n och rapportmall.

## Innan du börjar

Det här skriver i användarens riktiga Bear-bibliotek. Säg i en rad vad du är på
väg att göra och kör sedan Step 0 i protokollet. Blockera inte på godkännande
för själva testnoten, den städas bort i Phase 7, men avbryt direkt om Step 0
säger att den anslutna servern är stale: då testar du gammal kod och ett grönt
resultat är värdelöst.

## Läge

- **Fullt varv (default).** Step 0 och Phase 1 till 7, båda `EYES`-checkpoints,
  hela rapporten.
- **Delvarv.** Användaren kan peka ut faser (`/bear-protocol phase 1-3`, "bara
  skrivvägen"). Kör Step 0 ändå, kör alltid Phase 7 så biblioteket blir städat,
  och skriv i rapporten vilka faser som hoppades över.
- **Utan användaren närvarande.** Om ingen kan svara på `EYES`-frågorna: kör
  resten, markera dem `skipped`, och säg i rapporten att renderingen i Bears UI
  är overifierad. Hitta inte på svar och tolka inte SQLite-innehåll som ett svar
  på en fråga om hur Bear ritar noten.

## Under körningen

- En write i taget, verifierad mot den råa `sqlite3`-frågan innan nästa. Ett
  `Sent to Bear:` är inget bevis.
- Rör ingenting du inte själv skapade. `bear_rename_tag` och `bear_delete_tag`
  slår över hela biblioteket.
- Poll:a, sov inte blint. Om något aldrig dyker upp: skriv hur länge du väntade
  och behandla det som en fallerad write med protokollets förbehåll.
- Fortsätt efter en fallerad check om nästa fas ändå är meningsfull, och kör
  alltid Phase 7. Diagnostisera inte mitt i varvet, samla i rapporten.

## Efteråt

Rapportera i protokollets ordning: miljö, `typecheck` + `bun test`, resultattabell
per check-id, fallerade checkar med exakt verktygssvar och frågeutdata, det du
inte kunde verifiera, och vad som ligger kvar i biblioteket.

Säg också att noten ligger i papperskorgen och att användaren själv kan tömma
den. Bears API har ingen permanent delete.

Om körningen hittade en bugg: fixa den inte i samma andetag utan att fråga.
Rapporten är leveransen, och en fix mitt i ett testvarv gör att ingen vet vilken
kod som faktiskt kördes.
