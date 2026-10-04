# Wiezer

*/ˈwiːzər/ — rhymes with "freezer"*

*Deutsche Anleitung weiter unten.*

## Usage

After starting the add-on, open **Wiezer** in the Home Assistant sidebar.

- **Add:** tap **Freeze**, type what it is, choose drawer, unit and amount, and save.
  Things you've frozen before are suggested while typing; picking a suggestion fills in
  the drawer, unit and amount from last time. The date defaults to today.
- **Amounts:** turn the digit wheels, use the arrows above and below each digit, or tap
  **Type amount** to enter the whole number.
- **Take out:** tap an entry, set the amount (it starts at the unit's step size) and tap
  **Take out**. **All** takes everything. An entry disappears when it reaches zero.
- **Label text:** after saving, or in an entry's details, tap **Copy label text**. The
  name goes on the first line, amount and date on the second.
- **Settings** (top right): language and theme per person; drawers, drawer groups and
  units for everyone.

### Units

Each unit has a singular and an optional plural ("Portion / Portionen"), a step size,
and whether one decimal place is allowed. The step size is where the amount starts when
taking something out, e.g. 100 for grams. The built-in units are translated
automatically; once you rename one, it's shown exactly as you typed it.

### Notes

- Data is stored inside the add-on and is part of your Home Assistant backups.
- Copying uses the browser clipboard. If it isn't allowed (for example on a plain `http`
  connection), a dialog shows the text so you can copy it by pressing and holding.
- The add-on only accepts connections through Home Assistant and has no extra
  permissions.

---

## Anleitung (Deutsch)

Nach dem Start erscheint **Wiezer** in der Seitenleiste von Home Assistant.

- **Einfrieren:** auf **Einfrieren** tippen, eintragen, was es ist, Schublade, Einheit
  und Menge wählen, speichern. Früher Eingefrorenes wird beim Tippen vorgeschlagen; ein
  Vorschlag übernimmt Schublade, Einheit und Menge vom letzten Mal. Als Datum ist heute
  voreingestellt.
- **Mengen:** an den Zahlenrädchen drehen, die Pfeile über und unter jeder Ziffer nutzen
  oder **Menge eintippen** wählen und die ganze Zahl eingeben.
- **Entnehmen:** Eintrag antippen, Menge einstellen (startet bei der Schrittweite der
  Einheit), **Entnehmen**. **Alles** nimmt den ganzen Eintrag. Bei null verschwindet der
  Eintrag.
- **Etikettentext:** nach dem Speichern oder in den Details eines Eintrags **Etikettentext
  kopieren** wählen. In der ersten Zeile steht der Name, in der zweiten Menge und Datum.
- **Einstellungen** (oben rechts): Sprache und Design für jede Person; Schubladen,
  Schubladengruppen und Einheiten für alle.

### Einheiten

Jede Einheit hat eine Einzahl, eine optionale Mehrzahl („Portion / Portionen“), eine
Schrittweite und die Angabe, ob eine Nachkommastelle erlaubt ist. Die Schrittweite ist der
Startwert beim Entnehmen, z. B. 100 bei Gramm. Die mitgelieferten Einheiten werden
automatisch übersetzt; sobald man eine umbenennt, erscheint sie genau wie eingegeben.

### Hinweise

- Die Daten liegen im Add-on und sind Teil der Home-Assistant-Backups.
- Zum Kopieren wird die Zwischenablage des Browsers genutzt. Ist das nicht erlaubt (z. B.
  bei einer einfachen `http`-Verbindung), zeigt ein Dialog den Text zum Kopieren durch
  Gedrückthalten.
- Das Add-on nimmt nur Verbindungen über Home Assistant an und hat keine zusätzlichen
  Berechtigungen.
