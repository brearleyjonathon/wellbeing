'use strict';

/*
 * Wellbeing — a sidebar for the mood/energy/focus scores kept in daily-note
 * frontmatter.
 *
 * This used to be an HTML heatmap that daily_note.py appended to each morning's
 * note. Living in the sidebar instead means one panel for the whole trailing
 * window, and the scores can be logged by clicking rather than by editing YAML.
 *
 * The notes are the only store: every score read and written is the `mood`,
 * `energy` and `focus` frontmatter of a daily note. 0 or missing means "not
 * logged", which is what the Daily template seeds each note with.
 */

const { Plugin, ItemView, PluginSettingTab, Setting, Notice, debounce, normalizePath } = require('obsidian');

const VIEW_TYPE_WELLBEING = 'wellbeing-view';

const METRICS = [
    { key: 'mood', label: 'Mood', short: 'M' },
    { key: 'energy', label: 'Energy', short: 'E' },
    { key: 'focus', label: 'Focus', short: 'F' },
];

const DEFAULT_SETTINGS = {
    dailyFolder: '01_Daily Notes',
    days: 30,
};

const SCALE_MAX = 10;

/* Daily notes are filed as YYYY/MM-Month/DD-Weekday.md. The names are the
 * English ones daily_note.py writes with strftime, so they are spelled out
 * here rather than taken from the runtime locale, which would silently
 * mis-file the path on a non-English system. */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday',
    'Friday', 'Saturday'];

const pad2 = (n) => String(n).padStart(2, '0');

function startOfDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
}

function addDays(date, n) {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
}

function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear()
        && a.getMonth() === b.getMonth()
        && a.getDate() === b.getDate();
}

function isoDate(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function dailyNotePath(folder, date) {
    const year = date.getFullYear();
    const month = `${pad2(date.getMonth() + 1)}-${MONTHS[date.getMonth()]}`;
    const day = `${pad2(date.getDate())}-${WEEKDAYS[date.getDay()]}`;
    return normalizePath(`${folder}/${year}/${month}/${day}.md`);
}

/* Map a 1..10 score onto the same red-to-green ramp the old appended heatmap
 * used, so a month of notes and this panel read as the same scale. */
function heatColor(v) {
    const clamped = Math.max(1, Math.min(SCALE_MAX, v));
    const hue = ((clamped - 1) / (SCALE_MAX - 1)) * 120;
    return `hsl(${Math.round(hue)}, 62%, 60%)`;
}


// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

class WellbeingPlugin extends Plugin {
    async onload() {
        await this.loadSettings();

        this.registerView(VIEW_TYPE_WELLBEING, (leaf) => new WellbeingView(leaf, this));

        this.addRibbonIcon('activity', 'Open Wellbeing', () => this.activateView());

        this.addCommand({
            id: 'open-wellbeing',
            name: 'Open wellbeing sidebar',
            callback: () => this.activateView(),
        });

        this.addSettingTab(new WellbeingSettingTab(this.app, this));

        /* Both of these fire once per file while Obsidian builds its caches at
         * startup, so they are registered only after layout is ready and the
         * repaint is debounced. Otherwise opening a vault of any size repaints
         * the panel hundreds of times before it has shown anything. */
        this.scheduleRefresh = debounce(() => this.refreshViews(), 200, true);
        this.app.workspace.onLayoutReady(() => {
            const touchesDailyNotes = (file) =>
                file && file.path.startsWith(normalizePath(this.settings.dailyFolder));

            /* A score written from the panel, and one typed into a note by
             * hand, both land as a metadata change. Repainting from that one
             * event keeps the panel honest about what is actually on disk. */
            this.registerEvent(this.app.metadataCache.on('changed', (file) => {
                if (touchesDailyNotes(file)) this.scheduleRefresh();
            }));
            this.registerEvent(this.app.vault.on('create', (file) => {
                if (touchesDailyNotes(file)) this.scheduleRefresh();
            }));
        });
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.refreshViews();
    }

    refreshViews() {
        this.app.workspace.getLeavesOfType(VIEW_TYPE_WELLBEING).forEach((leaf) => {
            if (leaf.view instanceof WellbeingView) leaf.view.render();
        });
    }

    async activateView() {
        const { workspace } = this.app;
        const existing = workspace.getLeavesOfType(VIEW_TYPE_WELLBEING);
        if (existing.length) {
            workspace.revealLeaf(existing[0]);
            return;
        }
        const leaf = workspace.getRightLeaf(false);
        if (!leaf) return;
        await leaf.setViewState({ type: VIEW_TYPE_WELLBEING, active: true });
        workspace.revealLeaf(leaf);
    }
}


// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

class WellbeingView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        /* Which day the scale buttons at the top write to. Today by default;
         * clicking a row in the history moves it, so a missed day can be
         * filled in without opening its note. */
        this.selected = startOfDay(new Date());
    }

    getViewType() { return VIEW_TYPE_WELLBEING; }
    getDisplayText() { return 'Wellbeing'; }
    getIcon() { return 'activity'; }

    async onOpen() {
        this.render();
    }

    /* Read the trailing window straight from the notes, newest first. Each day
     * has a deterministic path, so this is N lookups rather than a vault walk. */
    history() {
        const { dailyFolder, days } = this.plugin.settings;
        const today = startOfDay(new Date());
        const out = [];
        for (let i = 0; i < days; i++) {
            const date = addDays(today, -i);
            const path = dailyNotePath(dailyFolder, date);
            const file = this.app.vault.getAbstractFileByPath(path);
            const fm = file ? (this.app.metadataCache.getFileCache(file)?.frontmatter || {}) : {};
            const scores = {};
            for (const m of METRICS) {
                const v = Number(fm[m.key]);
                scores[m.key] = Number.isFinite(v) && v > 0 ? Math.round(v) : null;
            }
            out.push({ date, path, file, scores });
        }
        return out;
    }

    async setScore(day, key, value) {
        if (!day.file) {
            new Notice(`No daily note for ${isoDate(day.date)} yet.`);
            return;
        }
        try {
            await this.app.fileManager.processFrontMatter(day.file, (fm) => {
                fm[key] = value;
            });
        } catch (e) {
            new Notice(`Could not write ${key}: ${e.message}`);
            return;
        }
        this.render();
    }

    render() {
        const root = this.contentEl;
        root.empty();
        root.addClass('wellbeing-view');

        const days = this.history();
        const selectedDay = days.find((d) => sameDay(d.date, this.selected)) || days[0];

        this.renderLogger(root, selectedDay);
        this.renderHistory(root, days, selectedDay);
        this.renderAverages(root, days);
    }

    // --- today's (or the selected day's) scores ---------------------------

    renderLogger(root, day) {
        const box = root.createDiv({ cls: 'wb-logger' });

        const isToday = sameDay(day.date, startOfDay(new Date()));
        const header = box.createDiv({ cls: 'wb-logger-header' });
        header.createSpan({
            cls: 'wb-logger-title',
            text: isToday ? 'Today' : `${WEEKDAYS[day.date.getDay()]} ${day.date.getDate()}`,
        });
        header.createSpan({ cls: 'wb-logger-date', text: isoDate(day.date) });

        if (!day.file) {
            box.createDiv({
                cls: 'wb-empty',
                text: 'No daily note for this day, so there is nowhere to write a '
                    + 'score. It appears once the 6am job creates the note.',
            });
            return;
        }

        for (const metric of METRICS) {
            const row = box.createDiv({ cls: 'wb-scale-row' });
            const current = day.scores[metric.key];

            const label = row.createDiv({ cls: 'wb-scale-label' });
            label.createSpan({ text: metric.label });
            label.createSpan({
                cls: 'wb-scale-value',
                text: current === null ? '—' : String(current),
            });

            const scale = row.createDiv({ cls: 'wb-scale' });
            for (let v = 1; v <= SCALE_MAX; v++) {
                const btn = scale.createEl('button', {
                    cls: 'wb-scale-btn',
                    text: String(v),
                    attr: { 'aria-label': `${metric.label} ${v}`, type: 'button' },
                });
                if (current !== null && v <= current) {
                    btn.addClass('is-filled');
                    btn.style.background = heatColor(current);
                }
                if (v === current) btn.addClass('is-current');
                /* Clicking the value that is already set clears it back to 0,
                 * which is what the Daily template seeds and what every reader
                 * here treats as "not logged". */
                btn.onclick = () => this.setScore(day, metric.key, v === current ? 0 : v);
            }
        }
    }

    // --- trailing history, one row per day --------------------------------

    renderHistory(root, days, selectedDay) {
        const box = root.createDiv({ cls: 'wb-history' });

        const head = box.createDiv({ cls: 'wb-row wb-row-head' });
        head.createDiv({ cls: 'wb-day-label', text: `${days.length}d` });
        for (const metric of METRICS) {
            head.createDiv({ cls: 'wb-cell wb-cell-head', text: metric.short });
        }

        let lastMonth = null;
        for (const day of days) {
            const month = day.date.getMonth();
            if (lastMonth !== null && month !== lastMonth) {
                box.createDiv({
                    cls: 'wb-month-break',
                    text: MONTHS[month].slice(0, 3),
                });
            }
            lastMonth = month;

            const row = box.createDiv({ cls: 'wb-row wb-day-row' });
            if (sameDay(day.date, selectedDay.date)) row.addClass('is-selected');
            if (sameDay(day.date, startOfDay(new Date()))) row.addClass('is-today');
            if (!day.file) row.addClass('is-missing');

            row.createDiv({
                cls: 'wb-day-label',
                text: `${WEEKDAYS[day.date.getDay()].slice(0, 3)} ${day.date.getDate()}`,
            });

            for (const metric of METRICS) {
                const v = day.scores[metric.key];
                const cell = row.createDiv({
                    cls: 'wb-cell',
                    text: v === null ? '·' : String(v),
                });
                if (v === null) {
                    cell.addClass('wb-cell-empty');
                } else {
                    cell.style.background = heatColor(v);
                }
            }

            row.onclick = () => {
                this.selected = day.date;
                this.render();
            };
        }
    }

    // --- window averages ---------------------------------------------------

    renderAverages(root, days) {
        const box = root.createDiv({ cls: 'wb-averages' });

        const parts = METRICS.map((metric) => {
            const vals = days.map((d) => d.scores[metric.key]).filter((v) => v !== null);
            const avg = vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : '—';
            return `${metric.label} ${avg}`;
        });

        const logged = days.filter((d) => METRICS.some((m) => d.scores[m.key] !== null)).length;

        box.createDiv({ cls: 'wb-averages-line', text: parts.join(' · ') });
        box.createDiv({
            cls: 'wb-averages-sub',
            text: `${days.length}-day average, from ${logged} logged day${logged === 1 ? '' : 's'}`,
        });
    }
}


// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

class WellbeingSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Daily notes folder')
            .setDesc('Vault-relative root of the daily notes. Notes are expected at '
                + 'YYYY/MM-Month/DD-Weekday.md beneath it.')
            .addText((text) => text
                .setPlaceholder(DEFAULT_SETTINGS.dailyFolder)
                .setValue(this.plugin.settings.dailyFolder)
                .onChange(async (value) => {
                    this.plugin.settings.dailyFolder = value.trim() || DEFAULT_SETTINGS.dailyFolder;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Days shown')
            .setDesc('How many trailing days the history lists.')
            .addSlider((slider) => slider
                .setLimits(7, 90, 1)
                .setValue(this.plugin.settings.days)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.days = value;
                    await this.plugin.saveSettings();
                }));
    }
}


module.exports = WellbeingPlugin;
