# PostgreSQL-Setup: Sofort-Hilfe & Fehlersuche

> Gilt für `./scripts/setup-cachyos.sh` (CachyOS/Arch, PostgreSQL 14–18+).
> Kurzversion für den aktuellen Fall: **Abschnitt 1** — danach Punkt für Punkt.

---

## 1. Dein aktueller Zustand („initdb OK, aber Skript sagt unvollständig“)

Das war **kein** echter Cluster-Defekt: `initdb` hat den Cluster erfolgreich
angelegt („Erfolg …“). Das alte Skript prüfte die Dateien aber **als dein
Benutzer** — und `initdb` setzt `/var/lib/postgres` und `/var/lib/postgres/data`
auf `0700 postgres:postgres`. Für dein Konto sind die Dateien damit unsichtbar
(`Permission denied`), das Skript hielt den Cluster fälschlich für unvollständig.
Seit v1.5.4 laufen **alle Cluster-Prüfungen als postgres-Benutzer** — das
Skript erkennt einen vollständigen Cluster jetzt korrekt und bietet **keine**
Neuinitialisierung mehr an, wenn Daten vorhanden sind.

### Schritt für Schritt (genau in dieser Reihenfolge)

1. **Nichts löschen!** `sudo rm -rf /var/lib/postgres` ist nur nötig, wenn du
   die Daten bewusst aufgeben willst. Der Cluster ist intakt.

2. **Cluster-Status prüfen:**
   ```bash
   sudo -u postgres ls -la /var/lib/postgres/data /var/lib/postgres/data/global
   sudo -u postgres pg_controldata -D /var/lib/postgres/data | head -20
   cat /var/lib/postgres/data/PG_VERSION 2>/dev/null   # → z. B. 18
   postgres --version                                  # → muss gleiche Major zeigen
   ```
   Beide Versionen müssen übereinstimmen (18 ↔ 18). Bei Mismatch → Abschnitt 4.

3. **PostgreSQL starten** (der saubere Weg über systemd):
   ```bash
   sudo systemctl enable --now postgresql
   pg_isready          # → "accepting connections"
   ```
   Falls systemd nicht mag, den Dienst **nicht** als root und **nicht** als
   normaler Benutzer starten, sondern als postgres:
   ```bash
   sudo -u postgres pg_ctl -D /var/lib/postgres/data \
     -l /var/lib/postgres/data/postgres.log start
   sudo -u postgres pg_ctl -D /var/lib/postgres/data status
   ```
   ⚠️ **Falsch (deshalb deine Fehler oben):**
   - `pg_ctl -D … start` als normaler Benutzer → *„Keine Berechtigung“* (Verzeichnis 0700 postgres)
   - `sudo pg_ctl …` → *„kann nicht als root ausgeführt werden“* — root darf
     den postgres-Serverprozess nie starten!

4. **Setup-Skript erneut ausführen** — es erkennt den Cluster jetzt und fährt
   mit Benutzer/Datenbank/.env fort:
   ```bash
   ./scripts/setup-cachyos.sh --variant a
   ```

5. **Aufräumen** (optional): Bei deinem manuellen `pg_ctl`-Versuch kann eine
   leere Datei `logdatei` im Projektordner entstanden sein — löschen:
   ```bash
   rm -f logdatei
   ```

---

## 2. „Datenverzeichnis existiert nicht oder ist leer“

Seit v1.5.4 stimmt die Diagnose (vorher konnte auch nur ein Rechteproblem
gemeint sein). Prüfen:

```bash
sudo ls -ld /var/lib/postgres /var/lib/postgres/data   # existiert? Owner?
sudo -u postgres ls -A /var/lib/postgres/data          # Inhalt (als postgres)
```

- **Existiert nicht / leer** → Skript legt es per `initdb` an (Frage mit „j“ bestätigen).
- **Existiert, gehört aber root** → Rechte korrigieren, *dann* Skript erneut:
  ```bash
  sudo chown -R postgres:postgres /var/lib/postgres
  ```

## 3. „Cluster nach initdb weiterhin unvollständig“ (altes v1.5.3-Skript)

Mit v1.5.4 behoben. Wenn es **trotzdem** auftritt, ist initdb wirklich gescheitert
— dann diagnose:

```bash
sudo -u postgres ls -la /var/lib/postgres/data/global
sudo -u postgres pg_controldata -D /var/lib/postgres/data
df -h /var/lib/postgres                # Platte voll?
sudo journalctl -u postgresql -n 30 --no-pager
```

Typische echte Ursachen: Platte voll, initdb als root statt postgres,
Locale `C.UTF-8` fehlt (Skript fällt seit v1.5.4 auf `C` zurück).

## 4. Version-Mismatch (Cluster 17 ↔ Server 18 o. Ä.)

PostgreSQL-Cluster sind **nicht** zwischen Major-Versionen abwärtskompatibel.
Das Skript bricht jetzt ab, statt Daten zu zerstören. Es gibt zwei Wege:

**A) pg_upgrade (Daten erhalten):**
```bash
sudo -u postgres pg_dumpall > /tmp/full_dump.sql        # erst Backup!
sudo systemctl stop postgresql
# neuen Cluster mit dem neuen Server initialisieren:
sudo -u postgres initdb -D /var/lib/postgres/data-new --locale=C.UTF-8 --encoding=UTF8
sudo -u postgres pg_ctl -D /var/lib/postgres/data-new start
sudo -u postgres psql -d postgres -f /tmp/full_dump.sql
```
**B) Neuinitialisierung (Daten bewusst verwerfen):**
```bash
sudo systemctl stop postgresql
sudo rm -rf /var/lib/postgres/data
./scripts/setup-cachyos.sh --variant a    # fragt erneut nach
```

## 5. `postmaster.pid` / „lock file exists“ / „already running“

```bash
sudo -u postgres cat /var/lib/postgres/data/postmaster.pid   # PID lesen?
ps -p <PID> -o user,args                                     # läuft der Prozess?
```
- Prozess läuft → stoppen (`sudo systemctl stop postgresql`, sonst
  `sudo -u postgres pg_ctl -D /var/lib/postgres/data stop`).
- Prozess läuft nicht mehr → veraltete PID-Datei entfernen:
  ```bash
  sudo -u postgres rm -f /var/lib/postgres/data/postmaster.pid
  ```
  Das Skript macht beides seit v1.5.4 automatisch.

## 6. Port 5432 belegt (fremder Prozess)

```bash
sudo ss -ltnp 'sport = :5432'    # Wer lauscht?
sudo fuser 5432/tcp
```
- Fremder Dienst (anderes PG, Docker, etc.) → stoppen oder das Setup auf den
  richtigen Port umstellen.
- Eigener, manuell gestarteter pg_ctl-Prozess auf demselben Datenverzeichnis →
  das Skript nutzt ihn seit v1.5.4 weiter (Warnung statt Abbruch).

## 7. sudo / Benutzer-Probleme

```bash
id postgres          # fehlt? → sudo pacman -S postgresql (legt den User an)
id                  # bist du in der wheel-Gruppe? → sudo usermod -aG wheel $USER
sudo -n true         # "not in the sudoers" → /etc/sudoers: %wheel ALL=(ALL:ALL) ALL
```

## 8. Datenverzeichnis-Rechte (nach manuellen Eingriffen)

```bash
sudo chown -R postgres:postgres /var/lib/postgres
sudo chmod 700 /var/lib/postgres /var/lib/postgres/data
```

## 9. Logs ansehen

```bash
sudo journalctl -u postgresql -n 50 --no-pager       # systemd-Sicht
sudo -u postgres tail -n 50 /var/lib/postgres/data/*.log 2>/dev/null
```

---

## Wie das Skript entscheidet (v1.5.4)

| Prüfung | Als welcher User | Wirkung bei Fehlschlag |
| --- | --- | --- |
| `PG_VERSION` + `global/pg_control` + `base/` | postgres | Cluster unvollständig → Neuinitialisierung anbieten |
| `global/pg_filenode.map` (nur PG ≤ 18) | postgres | unvollständig; PG ≥ 19: nur Warnung |
| Cluster-Major ↔ Server-Major (PG_VERSION + pg_controldata) | postgres | **Abbruch mit pg_upgrade-Hinweis, kein Löschen** |
| Dienst-Registrierung / Port 5432 | systemd/root | Fremdinstanz → Abbruch; eigene Instanz → weiterverwenden |
| `postmaster.pid` | postgres | veraltet → entfernen; Prozess lebt → Warnung |
