/**
 * The maximum number of attempts to reconnect to the background script
 * before giving up and refreshing the page.
 */
const MAX_RETRIES = 3;

// Regex to extract the primary professor's name when the registration page renders it as
// "Lastname, Firstname (Primary)" (Banner's default format, used by Georgia Tech).
const PRIMARY_PROFESSOR_REGEX_COMMA = /^([\w'-]+(?:\s+[\w'-]+)*),\s*([\w'-]+)(?:\s+[A-Z]\.)?\s*\(Primary\)/;

// Regex to extract the primary professor's name when the registration page renders it as
// "Firstname Lastname (Primary)" (used by some Banner instances, e.g. UGA's).
const PRIMARY_PROFESSOR_REGEX_SPACE = /([\w-]+)\s+(?:[A-Z]\.\s+)?([\w-]+)\s*\(Primary\)/;

/**
 * Detects a section with two or more co-instructors (see extractInstructors, which splits the
 * cell into individual names once this returns true).
 *
 * Only the primary instructor's name is suffixed "(Primary)" - a co-taught section lists the
 * other instructor(s) with no such suffix, so counting "(Primary)" occurrences alone misses
 * this case entirely (and did, in practice). Each instructor's name is normally its own
 * mailto: link, so that's checked first; a text-based count of "Lastname, Firstname"-shaped
 * segments is a fallback for an instructor with no email on file (e.g. "Staff").
 *
 * @param {HTMLTableCellElement} cell - The instructor <td> itself (not just its text).
 * @return {boolean}
 */
function hasMultipleInstructors(cell) {
    if (cell.querySelectorAll('a[href^="mailto:"]').length > 1) {
        return true;
    }
    const nameMatches = cell.textContent.match(/[\w'-]+(?:\s+[\w'-]+)*,\s*[\w'-]+/g);
    return !!nameMatches && nameMatches.length > 1;
}

/**
 * Splits a co-taught section's instructor cell into its individual instructors. Only the
 * (Primary) instructor's name is suffixed "(Primary)"; co-instructors have no such marker, so
 * this captures the marker as optional per match rather than assuming every name has one.
 *
 * Based on the one real multi-instructor cell seen so far (two "Lastname, Firstname" segments
 * back to back, one followed by "(Primary)", no separator between them other than whitespace).
 * If Banner's actual markup turns out to separate/format co-instructors differently in some
 * other case, this is the one place that would need adjusting.
 *
 * @param {HTMLTableCellElement} cell
 * @return {Array<{name: string, isPrimary: boolean}>} Each instructor, normalized to "First Last".
 */
function extractInstructors(cell) {
    const regex = /([\w'-]+(?:\s+[\w'-]+)*),\s*([\w'-]+)(?:\s+[A-Z]\.)?\s*(\(Primary\))?/g;
    const text = cell.textContent;
    const instructors = [];

    let match;
    while ((match = regex.exec(text)) !== null) {
        const [, lastName, firstName, primaryMarker] = match;
        instructors.push({name: `${firstName} ${lastName}`, isPrimary: !!primaryMarker});
    }

    return instructors;
}

// Store processed professor names as keys and their metrics as values
const profMap = new Map();

// Store processed course IDs ("SUBJECT NUMBER", e.g. "PHYS 2212") as keys and their
// Course Critique data as values.
const courseMap = new Map();

/**
 * Retrieves professor metrics from the background service worker.
 *
 * @param {string} professorName - The name of the professor to retrieve metrics for.
 * @returns {Promise<Object>}  A Promise that resolves with an object containing the professor's name and metrics
 *                             or rejects with an Error if the retrieval fails. The resolved object has the form:
 *                             { name: professorName, metrics: { ... metrics data ... } }
 */
async function getProfessorMetrics(professorName) {
    const port = chrome.runtime.connect({name: "professorMetrics"});
    return new Promise((resolve, reject) => {
        port.postMessage({professorName: professorName});

        /**
         * Event listener for messages from the service worker.
         * Resolves or rejects the Promise based on the received message.
         *
         * @param msg - The message received from the service worker.
         */
        function messageListener(msg) {
            try {
                if (msg.professorMetrics) {
                    port.onMessage.removeListener(messageListener);
                    resolve(msg.professorMetrics);
                } else {
                    port.onMessage.removeListener(messageListener);
                    reject(new Error(`Failed to get metrics for professor ${professorName}`));
                }
            } finally {
                // Close port for cleanup
                port.disconnect();
            }
        }

        port.onMessage.addListener(messageListener);
    });
}

/**
 * Retrieves Course Critique data from the background service worker.
 *
 * @param {string} courseID - e.g. "PHYS 2212" (subject code + course number, space-separated).
 * @returns {Promise<Object|null>} A Promise that resolves with the Course Critique data for the
 *                                 course (see background.js's `getCourseCritiqueData`), or `null`
 *                                 if no data was found. Rejects if the port communication fails.
 */
async function getCourseCritiqueData(courseID) {
    const port = chrome.runtime.connect({name: "courseCritiqueData"});
    return new Promise((resolve, reject) => {
        port.postMessage({courseID});

        function messageListener(msg) {
            try {
                if ('courseCritiqueData' in msg) {
                    port.onMessage.removeListener(messageListener);
                    resolve(msg.courseCritiqueData);
                } else {
                    port.onMessage.removeListener(messageListener);
                    reject(new Error(`Failed to get Course Critique data for ${courseID}`));
                }
            } finally {
                port.disconnect();
            }
        }

        port.onMessage.addListener(messageListener);
    });
}

/**
 * Strips a trailing lab/section letter off a course number (e.g. "1212K" -> "1212"), since
 * Course Critique keys its data by the bare numeric course number.
 *
 * @param {string} rawCourseNumber
 * @return {string}
 */
function cleanCourseNumber(rawCourseNumber) {
    const numericMatch = rawCourseNumber.match(/^(\d+)/);
    return numericMatch ? numericMatch[1] : rawCourseNumber;
}

/**
 * Determines a row's Course Critique course ID ("SUBJECT NUMBER", e.g. "PHYS 2211").
 *
 * Course Critique's API expects the subject's short code (e.g. "PHYS"), not the full subject
 * name Banner shows in its "Subject Description" cell (e.g. "Physics") — and there's no cell
 * anywhere in the row holding that short code as plain text. It only shows up in data-*
 * attributes on the row's action buttons/links (confirmed from a real row): the "View Sections"
 * button's `data-subject`/`data-course`, the "Add Course" button's
 * `data-attributes="SUBJECT,NUMBER"`, and a course-details link's
 * `data-attributes="TERM,SUBJECT,NUMBER"`. This tries each in turn, since not every row type is
 * guaranteed to render all three buttons/links.
 *
 * @param {HTMLTableRowElement} row - The <tr> to read the subject code and course number from.
 * @return {string|null} The course ID, or `null` if none of the known sources were found.
 */
// Learned "Subject Description" text (e.g. "Physics") -> subject code (e.g. "PHYS"), so that
// a row with no button/link of its own carrying the code can still resolve the SAME course ID
// as other rows of the same course that do. Without this, two rows of the same course could
// silently resolve to two different courseID strings depending on which button/link happened
// to be present, fracturing what should be one shared courseMap entry into two.
const subjectCodeByDescription = new Map();

function getCourseIDForRow(row) {
    const courseNumberCell = row.querySelector('td[data-property="courseNumber"]');
    const description = row.querySelector('td[data-property="subjectDescription"]')?.textContent.trim();

    const remember = (subjectCode) => {
        if (subjectCode && description && !subjectCodeByDescription.has(description)) {
            subjectCodeByDescription.set(description, subjectCode);
        }
        return subjectCode;
    };

    const sectionsButton = row.querySelector('button[data-subject]');
    if (sectionsButton) {
        const subjectCode = remember(sectionsButton.getAttribute('data-subject'));
        const courseNumber = sectionsButton.getAttribute('data-course') || courseNumberCell?.textContent.trim();
        if (subjectCode && courseNumber) {
            return `${subjectCode} ${cleanCourseNumber(courseNumber)}`;
        }
    }

    const addButton = row.querySelector('.add-course-button[data-attributes]');
    const addParts = addButton?.getAttribute('data-attributes')?.split(',');
    if (addParts?.length === 2) {
        const [subjectCode, courseNumber] = addParts;
        remember(subjectCode);
        return `${subjectCode} ${cleanCourseNumber(courseNumber)}`;
    }

    const detailsLink = row.querySelector('a[data-endpoint][data-attributes]');
    const detailsParts = detailsLink?.getAttribute('data-attributes')?.split(',');
    if (detailsParts?.length === 3) {
        const [, subjectCode, courseNumber] = detailsParts; // [term, subject, courseNumber]
        remember(subjectCode);
        return `${subjectCode} ${cleanCourseNumber(courseNumber)}`;
    }

    // This row carries no subject code of its own - fall back to one learned from a different
    // row of the same course elsewhere on the page (matched by identical Subject Description
    // text), if any row has supplied one yet.
    if (description && courseNumberCell && subjectCodeByDescription.has(description)) {
        const subjectCode = subjectCodeByDescription.get(description);
        return `${subjectCode} ${cleanCourseNumber(courseNumberCell.textContent.trim())}`;
    }

    return null;
}

/**
 * Processes an array of table rows representing courses, fetching Course Critique data for
 * each distinct course and populating `courseMap`.
 *
 * @param {Array<HTMLTableRowElement>} rows - Rows (<tr>) that contain course title/subject/number cells.
 * @returns {Promise<void>}
 */
async function processCourseRows(rows) {
    for (const row of rows) {
        const courseID = getCourseIDForRow(row);
        if (!courseID || courseMap.has(courseID)) {
            continue;
        }

        try {
            const data = await getCourseCritiqueData(courseID);
            courseMap.set(courseID, data);
        } catch (error) {
            if (error.message.includes('Extension context invalidated.')) {
                window.location.reload();
                return;
            }
            courseMap.set(courseID, null);
        }
    }
}

/**
 * Normalizes a professor's name from the format used on the registration page.
 * Handles both "Lastname, Firstname (Primary)" (Banner's default, e.g. Georgia Tech) and
 * "Firstname Lastname (Primary)" (e.g. UGA's customized Banner instance), including
 * variations with middle initials, hyphens, or apostrophes.
 *
 * @param {string} name - The professor's name to normalize.
 * @return {string} The normalized professor name in the format "FirstName LastName",
 *                  or the original name if the input format is not recognized.
 */
function normalizeProfessorName(name) {
    const commaMatch = name.match(PRIMARY_PROFESSOR_REGEX_COMMA);
    if (commaMatch) {
        const [, lastName, firstName] = commaMatch;
        return `${firstName} ${lastName}`;
    }

    const spaceMatch = name.match(PRIMARY_PROFESSOR_REGEX_SPACE);
    if (spaceMatch) {
        return `${spaceMatch[1]} ${spaceMatch[2]}`;
    }

    return name;
}

/**
 * Fetches a professor's metrics and caches the result in `profMap` (including a `null` result,
 * so a professor with no RMP page isn't looked up again every scan), retrying on a dropped
 * connection to the background service worker and reloading the page on an invalidated context.
 *
 * @param {string} professorName - Normalized ("First Last") professor name.
 * @param {number} retryCount - The current retry attempt count (used internally for reconnections).
 * @returns {Promise<void>}
 */
async function fetchAndCacheProfessorMetrics(professorName, retryCount = 0) {
    if (profMap.has(professorName)) {
        return; // Already processed
    }

    try {
        const metrics = await getProfessorMetrics(professorName);
        profMap.set(professorName, metrics);
    } catch (error) {
        if (error.message.includes('Extension context invalidated.')) {
            window.location.reload(); // Refresh the current tab to re-inject the content script
            return;
        }

        if (error.message.includes('Attempting to use a disconnected port object')) {
            // The connection to the background script has been lost
            if (retryCount >= MAX_RETRIES) {
                console.error(`Max retries (${MAX_RETRIES}) exceeded. Refreshing page.`);
                window.location.reload();
                return;
            }
            return fetchAndCacheProfessorMetrics(professorName, retryCount + 1);
        }

        profMap.set(professorName, null); // Store null to indicate failure
    }
}

/**
 * Processes an array of table elements containing professor names (one or more, co-taught
 * sections included), fetching metrics for each and populating `profMap`.
 *
 * @param {NodeListOf<Element>} tables - An array of table elements (<td>) representing professor names.
 * @returns {Promise<void>} A promise that resolves when all professors have been processed.
 */
async function processProfessorTables(tables) {
    for (const element of tables) {
        if (element.textContent.trim().length === 0) {
            continue; // Skip empty cells
        }

        if (hasMultipleInstructors(element)) {
            for (const instructor of extractInstructors(element)) {
                await fetchAndCacheProfessorMetrics(instructor.name);
            }
            continue;
        }

        const professorName = normalizeProfessorName(element.textContent.trim());
        await fetchAndCacheProfessorMetrics(professorName);
    }
}

/**
 * Creates a span element with the given text content.
 *
 * @param {string} text - The text content for the span.
 * @param {string} [className] - Optional CSS class to apply to the span.
 * @return {HTMLSpanElement} The created span element.
 */
function createSpan(text, className) {
    const span = document.createElement('span');
    span.textContent = text;
    if (className) {
        span.className = className;
    }
    return span;
}

// Small monochrome icons (not emoji, so they stay crisp and pick up the
// surrounding text color) prefixing each stat line.
const ICON_STAR = '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1l2.1 4.3 4.7.7-3.4 3.3.8 4.7L8 11.8 3.8 14l.8-4.7L1.2 6l4.7-.7L8 1z"/></svg>';
const ICON_DIFFICULTY = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 12a6 6 0 0 1 12 0"/><path d="M8 12 11 8"/></svg>';
const ICON_RATINGS_COUNT = '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h12v7H6l-3 3V10H2z"/></svg>';
const ICON_TAKE_AGAIN = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 8l3 3 7-7"/></svg>';
const ICON_GPA = '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1 2 4.5v3c0 3.6 2.4 6.8 6 7.5 3.6-.7 6-3.9 6-7.5v-3L8 1Zm0 2.2 4 2.2v1.6c0 2.7-1.7 5.1-4 5.7-2.3-.6-4-3-4-5.7V5.4l4-2.2Z"/><path d="M5 7h6v1.3H5V7Zm0 2.2h6v1.3H5V9.2Z"/></svg>';
// Small "i-in-a-circle" marking the GPA chip as hoverable, the same affordance Course
// Critique's own site uses next to its "GPA" column header.
const ICON_INFO = '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="6.3"/><line x1="8" y1="7.2" x2="8" y2="11.3"/><circle cx="8" cy="4.6" r="0.9" fill="currentColor" stroke="none"/></svg>';
const ICON_EXTERNAL_LINK = '<svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 3H3v10h10v-3"/><path d="M9 3h4v4"/><path d="M13 3 7 9"/></svg>';

/**
 * Creates a small "pill" link out to an external site (RMP, Course Critique), styled as a
 * distinct tappable chip rather than a plain inline text link, so it doesn't visually blend in
 * with Banner's own course-title/section links sitting right above it.
 *
 * @param {string} href
 * @param {string} label - Visible text, e.g. "RMP".
 * @param {string} title - Native tooltip / accessible name, e.g. "View on RateMyProfessors".
 * @param {string} modifierClass - 'ext-link-rmp' or 'ext-link-cc', for distinct accent colors.
 * @return {HTMLAnchorElement}
 */
function createExternalLinkAnchor(href, label, title, modifierClass) {
    const link = document.createElement('a');
    link.href = href;
    link.title = title;
    link.target = "_blank";
    link.className = `ext-link ${modifierClass}`;

    const icon = document.createElement('span');
    icon.className = 'ext-link-icon';
    icon.innerHTML = ICON_EXTERNAL_LINK;
    link.appendChild(icon);
    link.appendChild(document.createTextNode(label));

    return link;
}

/**
 * Creates a span containing a small icon followed by text.
 *
 * @param {string} svgMarkup - Trusted, hardcoded inline SVG markup for the icon.
 * @param {string} text - The text content following the icon.
 * @param {string} [className] - Optional CSS class to apply to the line.
 * @return {HTMLSpanElement} The created span element.
 */
function createStatLine(svgMarkup, text, className) {
    const line = document.createElement('span');
    if (className) {
        line.className = className;
    }

    const icon = document.createElement('span');
    icon.className = 'rmp-icon';
    icon.innerHTML = svgMarkup;
    line.appendChild(icon);
    line.appendChild(document.createTextNode(text));

    return line;
}

/**
 * Determines which CSS class should color-code an RMP overall rating,
 * so a professor's quality is visible at a glance without reading the number.
 *
 * @param {number} avgRating - The average overall rating (0-5).
 * @return {string} 'rmp-rating-good', 'rmp-rating-mid', or 'rmp-rating-bad'.
 */
function getRatingColorClass(avgRating) {
    if (avgRating >= 4) {
        return 'rmp-rating-good';
    }
    if (avgRating >= 2.5) {
        return 'rmp-rating-mid';
    }
    return 'rmp-rating-bad';
}

/**
 * Determines which CSS class should color-code a Course Critique GPA, so course/instructor
 * grade history is visible at a glance without reading the number.
 *
 * @param {number} avgGpa - The average GPA (0-4).
 * @return {string} 'cc-gpa-good', 'cc-gpa-mid', or 'cc-gpa-bad'.
 */
function getGpaColorClass(avgGpa) {
    if (avgGpa >= 3.5) {
        return 'cc-gpa-good';
    }
    if (avgGpa > 2.9) {
        return 'cc-gpa-mid';
    }
    return 'cc-gpa-bad';
}

// A single floating tooltip element, reused and repositioned for every Course Critique chip
// hover rather than creating one per chip. It's appended to <body> (not nested inside the
// table cell) and positioned with `position: fixed`, so it can never be clipped by the
// results table's own overflow/scroll styling, and never pushes neighboring columns around.
let ccTooltipEl = null;
let ccTooltipAnchor = null;

function getCcTooltipEl() {
    if (!ccTooltipEl) {
        ccTooltipEl = document.createElement('div');
        ccTooltipEl.className = 'cc-tooltip';
        document.body.appendChild(ccTooltipEl);

        // Safety nets against the tooltip getting stuck visible: a scroll (capture, so it also
        // catches scrolling inside the results table itself, not just the page) or resize
        // invalidates whatever position it was shown at, and the MutationObserver rebuilding a
        // chip out from under the cursor (see handleMutations) never fires that chip's own
        // mouseleave.
        window.addEventListener('scroll', hideCcTooltip, true);
        window.addEventListener('resize', hideCcTooltip);
    }
    return ccTooltipEl;
}

/**
 * Builds the grade-distribution breakdown shown inside a Course Critique tooltip.
 *
 * @param {string} label - Heading text, e.g. a course name or "Prof · Course".
 * @param {Object} stats - `{dist: {A,B,C,D,F,W}, passRate, withdrawRate}`.
 * @return {HTMLDivElement} The tooltip's content element.
 */
function buildCcTooltipContent(label, stats) {
    const BAR_COLORS = {A: '#3fae5c', B: '#8bc34a', C: '#e0a62e', D: '#e2672e', F: '#c0392b', W: '#8a93a6'};

    const container = document.createElement('div');

    const title = document.createElement('div');
    title.className = 'cc-tooltip-title';
    title.textContent = label;
    container.appendChild(title);

    const barsRow = document.createElement('div');
    barsRow.className = 'cc-tooltip-bars';
    for (const key of ['A', 'B', 'C', 'D', 'F', 'W']) {
        const pct = stats.dist?.[key] ?? 0;

        const col = document.createElement('div');
        col.className = 'cc-tooltip-bar-col';

        const pctLabel = document.createElement('div');
        pctLabel.className = 'cc-tooltip-bar-pct';
        pctLabel.textContent = `${pct.toFixed(1)}%`;

        const bar = document.createElement('div');
        bar.className = 'cc-tooltip-bar';
        // Scaled so a 100% bar tops out at 32px - leaves room, within the fixed-height bars
        // row, for the pct/key labels stacked above and below it without overflowing the box.
        bar.style.height = `${Math.max(3, Math.round(pct * 0.32))}px`;
        bar.style.background = BAR_COLORS[key];

        const keyLabel = document.createElement('div');
        keyLabel.className = 'cc-tooltip-bar-key';
        keyLabel.textContent = key;

        col.append(pctLabel, bar, keyLabel);
        barsRow.appendChild(col);
    }
    container.appendChild(barsRow);

    const footer = document.createElement('div');
    footer.className = 'cc-tooltip-footer';
    footer.appendChild(buildCcTooltipFooterStat("Pass rate", `${stats.passRate.toFixed(1)}%`));
    footer.appendChild(buildCcTooltipFooterStat("Withdraw", `${stats.withdrawRate.toFixed(1)}%`));
    container.appendChild(footer);

    return container;
}

/**
 * Builds one "label bold-value" stat line for the tooltip's footer row.
 *
 * @param {string} label - e.g. "Pass rate".
 * @param {string} value - e.g. "97.2%".
 * @return {HTMLSpanElement}
 */
function buildCcTooltipFooterStat(label, value) {
    const span = document.createElement('span');
    span.appendChild(document.createTextNode(`${label} `));
    const strong = document.createElement('strong');
    strong.textContent = value;
    span.appendChild(strong);
    return span;
}

/**
 * Shows the shared Course Critique tooltip anchored to a chip, flipping above the chip if
 * there isn't room below, and clamping horizontally so it never runs off the viewport edge.
 *
 * @param {HTMLElement} anchorEl - The chip element the tooltip is attached to.
 * @param {string} label - Heading text for the tooltip.
 * @param {Object} stats - `{dist, passRate, withdrawRate}`.
 */
function showCcTooltip(anchorEl, label, stats) {
    const tooltip = getCcTooltipEl();
    tooltip.innerHTML = '';
    tooltip.appendChild(buildCcTooltipContent(label, stats));
    // visibility: hidden (not display: none) keeps real layout geometry while the tooltip is
    // off, so its size can be measured below for positioning before the fade/slide-in plays.
    tooltip.classList.remove('cc-tooltip-visible');
    ccTooltipAnchor = anchorEl;

    const anchorRect = anchorEl.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();

    const spaceBelow = window.innerHeight - anchorRect.bottom;
    const openAbove = spaceBelow < tooltipRect.height + 12 && anchorRect.top > tooltipRect.height + 12;
    const top = openAbove ? anchorRect.top - tooltipRect.height - 8 : anchorRect.bottom + 8;

    const maxLeft = window.innerWidth - tooltipRect.width - 8;
    const left = Math.max(8, Math.min(anchorRect.left, maxLeft));

    tooltip.style.top = `${Math.max(8, top)}px`;
    tooltip.style.left = `${left}px`;
    tooltip.classList.add('cc-tooltip-visible');
}

function hideCcTooltip() {
    if (ccTooltipEl) {
        ccTooltipEl.classList.remove('cc-tooltip-visible');
    }
    ccTooltipAnchor = null;
}

/**
 * Closes the tooltip only if the chip it's anchored to has actually been removed from the page
 * (e.g. a MutationObserver scan rebuilt it out from under the cursor). Called on every scan
 * instead of unconditionally hiding, since Banner's own app re-renders parts of the DOM
 * continuously regardless of whether the user is doing anything — hiding on every scan closed
 * the tooltip almost as soon as it opened.
 */
function hideCcTooltipIfAnchorDetached() {
    if (ccTooltipAnchor && !document.contains(ccTooltipAnchor)) {
        hideCcTooltip();
    }
}

/**
 * Creates a color-coded GPA chip with a hover tooltip showing the grade-distribution breakdown.
 *
 * @param {string} tooltipLabel - Heading text for the hover tooltip.
 * @param {Object} stats - `{avgGpa, dist, passRate, withdrawRate}`.
 * @return {HTMLSpanElement} The created chip element.
 */
function createGpaChip(tooltipLabel, stats) {
    const chip = createStatLine(ICON_GPA, `GPA: ${stats.avgGpa.toFixed(2)}`, `cc-gpa-chip ${getGpaColorClass(stats.avgGpa)}`);

    const infoIcon = document.createElement('span');
    infoIcon.className = 'cc-info-icon';
    infoIcon.innerHTML = ICON_INFO;
    chip.appendChild(infoIcon);

    chip.setAttribute('aria-label', `GPA ${stats.avgGpa.toFixed(2)}, hover for grade distribution breakdown`);
    chip.addEventListener('mouseenter', () => showCcTooltip(chip, tooltipLabel, stats));
    chip.addEventListener('mouseleave', hideCcTooltip);
    return chip;
}

/**
 * Creates the anchor linking to a course's Course Critique page.
 *
 * @param {string} critiqueLink - The link to the course's Course Critique page.
 * @return {HTMLAnchorElement} The created anchor element.
 */
function createCritiqueLinkAnchor(critiqueLink) {
    return createExternalLinkAnchor(critiqueLink, "Course Critique", "View on Course Critique", "ext-link-cc");
}

/**
 * Creates the block shown in a course's Title cell: overall GPA chip + grade-distribution
 * hover tooltip + link to Course Critique, or a muted fallback if no data was found.
 *
 * @param {string} courseLabel - e.g. "PHYS 2212" — used as the tooltip heading.
 * @param {Object|null} courseCritiqueData - This course's aggregated Course Critique data.
 * @return {HTMLDivElement} The created DOM element.
 */
function createCourseCritiqueBlock(courseLabel, courseCritiqueData) {
    const block = document.createElement('div');
    block.className = 'cc-course-block';
    // Banner's Title cell carries its own title="<full course name>" attribute. Without this,
    // hovering anything inside this block (the chip, its icon) falls back to that ancestor's
    // title and pops up Banner's native tooltip on top of our custom one. An empty title here
    // stops that lookup from bubbling any further up the DOM.
    block.title = '';

    if (courseCritiqueData === null) {
        block.appendChild(createSpan("No Course Critique data.", "rmp-no-data"));
        return block;
    }

    block.appendChild(createGpaChip(courseLabel, courseCritiqueData));
    block.appendChild(document.createElement('br'));
    block.appendChild(createCritiqueLinkAnchor(courseCritiqueData.critiqueLink));

    return block;
}

/**
 * Appends this specific instructor's Course Critique GPA (for the course they're teaching in
 * this row) onto an existing RMP rating box, separated by a thin divider.
 *
 * @param {HTMLDivElement} ratingDiv - The RMP rating box element (from `createRatingElement`).
 * @param {string} courseLabel - e.g. "PHYS 2212" — used as the tooltip heading.
 * @param {Object|null} courseCritiqueData - The course's aggregated Course Critique data.
 * @param {string} professorName - The normalized professor name to look up within `byInstructor`.
 */
function appendInstructorCritiqueData(ratingDiv, courseLabel, courseCritiqueData, professorName) {
    const divider = document.createElement('div');
    divider.className = 'cc-divider';
    ratingDiv.appendChild(divider);

    const instructorStats = courseCritiqueData?.byInstructor?.[professorName];
    if (!instructorStats) {
        ratingDiv.appendChild(createSpan("No Course Critique data for this instructor.", "rmp-no-data"));
        return;
    }

    ratingDiv.appendChild(createGpaChip(`${professorName} · ${courseLabel}`, instructorStats));
    ratingDiv.appendChild(document.createElement('br'));
    ratingDiv.appendChild(createCritiqueLinkAnchor(courseCritiqueData.critiqueLink));
}

/**
 * Creates the anchor linking to a professor's RateMyProfessor page.
 *
 * @param {string} RMPLink - The link to the professor's RateMyProfessor page.
 * @return {HTMLAnchorElement} The created anchor element.
 */
function createRMPLinkAnchor(RMPLink) {
    return createExternalLinkAnchor(RMPLink, "RMP", "View on RateMyProfessors", "ext-link-rmp");
}

/**
 * Creates a DOM element to display professor ratings.
 *
 * @param {Object} metrics - The professor's rating metrics.
 * @param {number} metrics.avgRating - The average overall rating (e.g., 4.5).
 * @param {number} metrics.avgDifficulty - The average difficulty rating (e.g., 3.2).
 * @param {number} metrics.numRatings - The total number of ratings.
 * @param {number} metrics.wouldTakeAgainPercent - The percentage of students who would take the course again (0-100).
 * @param {string} metrics.RMPLink - The link to the professor's RateMyProfessor page.
 * @returns {HTMLDivElement} The created DOM element.
 */
function appendRatingContent(container, metrics) {
    // Handle cases where the professor page does not exist
    if (metrics === null) {
        container.appendChild(createSpan("No Rate My Professor page found.", "rmp-no-data"));
        return;
    }

    // Handle cases where the professor has a page but no ratings have been submitted yet.
    // Showing 0/5 stats (or a link to an essentially empty page) here would be misleading.
    if (metrics.numRatings === 0) {
        container.appendChild(createSpan("No ratings yet.", "rmp-no-data"));
        return;
    }

    // The overall rating is the headline stat: an icon + the bare number, bold and
    // color-coded by quality so it reads at a glance.
    const overallClass = `rmp-rating-overall ${getRatingColorClass(metrics.avgRating)}`;
    container.appendChild(createStatLine(ICON_STAR, `${metrics.avgRating}`, overallClass));
    container.appendChild(document.createElement('br'));

    // Remaining stats stay muted and icon-prefixed, labels unchanged for now.
    container.appendChild(createStatLine(ICON_DIFFICULTY, `Difficulty: ${metrics.avgDifficulty} / 5`, "rmp-secondary"));
    container.appendChild(document.createElement('br'));
    container.appendChild(createStatLine(ICON_RATINGS_COUNT, `Total Ratings: ${metrics.numRatings}`, "rmp-secondary"));
    container.appendChild(document.createElement('br'));

    // wouldTakeAgainPercent can still be -1 (not enough responses to that specific question)
    // even when other ratings exist.
    if (metrics.wouldTakeAgainPercent === -1) {
        container.appendChild(createStatLine(ICON_TAKE_AGAIN, "Take again: N/A", "rmp-secondary"));
    } else {
        const roundedPercentage = Math.round(metrics.wouldTakeAgainPercent);
        container.appendChild(createStatLine(ICON_TAKE_AGAIN, `Take again: ${roundedPercentage}%`, "rmp-secondary"));
    }

    container.appendChild(document.createElement('br'));

    // Create and append link to the professor's RateMyProfessor page
    container.appendChild(createRMPLinkAnchor(metrics.RMPLink));
}

/**
 * Creates a DOM element to display one professor's ratings, in their own box.
 *
 * @param {Object} metrics - The professor's rating metrics.
 * @param {number} metrics.avgRating - The average overall rating (e.g., 4.5).
 * @param {number} metrics.avgDifficulty - The average difficulty rating (e.g., 3.2).
 * @param {number} metrics.numRatings - The total number of ratings.
 * @param {number} metrics.wouldTakeAgainPercent - The percentage of students who would take the course again (0-100).
 * @param {string} metrics.RMPLink - The link to the professor's RateMyProfessor page.
 * @returns {HTMLDivElement} The created DOM element.
 */
function createRatingElement(metrics) {
    const ratingDiv = document.createElement('div');
    ratingDiv.className = 'rmp-rating-box';
    ratingDiv.title = ''; // See the matching comment in createCourseCritiqueBlock
    appendRatingContent(ratingDiv, metrics);
    return ratingDiv;
}

/**
 * Creates one shared box for a co-taught section, stacking each instructor's own name, RMP
 * stats, and (when available) Course Critique GPA, separated by dividers.
 *
 * @param {Array<{name: string, isPrimary: boolean}>} instructors
 * @param {string|null} courseID - This row's course ID, for the Course Critique lookup.
 * @return {HTMLDivElement}
 */
function createMultiInstructorBox(instructors, courseID) {
    const box = document.createElement('div');
    box.className = 'rmp-rating-box';
    box.title = '';

    instructors.forEach((instructor, index) => {
        if (index > 0) {
            const divider = document.createElement('div');
            divider.className = 'cc-divider';
            box.appendChild(divider);
        }

        const nameLabel = document.createElement('div');
        nameLabel.className = 'rmp-coinstructor-name';
        nameLabel.textContent = instructor.isPrimary ? `${instructor.name} (Primary)` : instructor.name;
        box.appendChild(nameLabel);

        appendRatingContent(box, profMap.get(instructor.name) ?? null);

        if (courseID && courseMap.has(courseID)) {
            box.appendChild(document.createElement('br'));
            appendInstructorCritiqueData(box, courseID, courseMap.get(courseID), instructor.name);
        }
    });

    return box;
}

/**
 * Inserts the rating element into the correct table cell.
 *
 * @param {HTMLTableCellElement} professorCell - The name of the professor.
 * @param {HTMLDivElement} ratingElement - The element containing the formatted rating.
 */
function insertRating(professorCell, ratingElement) {
    professorCell.append(ratingElement);
}

/**
 * Updates the displayed professor ratings based on the profMap, and appends this instructor's
 * Course Critique GPA (for the course in that same row) when it's already available.
 */
async function updateProfessorRatings() {
    const professorCells = document.querySelectorAll('td[data-property="instructor"]');

    for (const cell of professorCells) {
        const rawCellText = cell.textContent.trim();

        if (!rawCellText) { // Skip empty cells
            const existingRatings = cell.querySelector('.rmp-rating-box');
            if (existingRatings) {
                existingRatings.remove();
            }
            delete cell.dataset.rmpRenderKey;
            continue;
        }

        if (hasMultipleInstructors(cell)) {
            const instructors = extractInstructors(cell);
            if (instructors.length === 0) {
                continue; // Couldn't parse any names out of the cell; nothing to render yet
            }

            const allMetricsReady = instructors.every((instructor) => profMap.has(instructor.name));
            if (!allMetricsReady) {
                continue; // Still waiting on one or more RMP lookups; the next scan will catch up
            }

            const row = cell.closest('tr');
            const courseID = row ? getCourseIDForRow(row) : null;
            const courseDataReady = courseID ? courseMap.has(courseID) : true;
            const renderKey = `multi::${instructors.map((i) => i.name).join('|')}::${courseID ?? ''}::${courseDataReady}`;

            if (cell.dataset.rmpRenderKey === renderKey) {
                continue;
            }

            const existingRatings = cell.querySelector('.rmp-rating-box');
            if (existingRatings) {
                existingRatings.remove();
            }

            insertRating(cell, createMultiInstructorBox(instructors, courseID));
            cell.dataset.rmpRenderKey = renderKey;
            continue;
        }

        const professorName = normalizeProfessorName(rawCellText);
        const row = cell.closest('tr');
        const courseID = row ? getCourseIDForRow(row) : null;
        // Whether Course Critique data for this row is available yet is part of the render
        // key, so the box gets rebuilt (once) the moment that data arrives.
        const courseDataReady = courseID ? courseMap.has(courseID) : true;
        const renderKey = `${professorName}::${courseID ?? ''}::${courseDataReady}`;

        // Banner's own app mutates the DOM continuously in the background, so this function
        // runs far more often than the underlying data actually changes. Rebuilding the box
        // every time regardless would yank a hovered GPA/RMP chip out from under the cursor on
        // every scan, breaking hover tracking (it could close, fail to open, or get stuck).
        // Skipping the rebuild when nothing has changed keeps the chip a stable DOM node across
        // scans, so native hover events work normally.
        if (cell.dataset.rmpRenderKey === renderKey) {
            continue;
        }

        const existingRatings = cell.querySelector('.rmp-rating-box');
        if (existingRatings) {
            existingRatings.remove();
        }

        const metrics = profMap.get(professorName);
        const ratingElement = createRatingElement(metrics);

        if (courseID && courseMap.has(courseID)) {
            appendInstructorCritiqueData(ratingElement, courseID, courseMap.get(courseID), professorName);
        }

        insertRating(cell, ratingElement);
        cell.dataset.rmpRenderKey = renderKey;
    }
}

/**
 * Updates each course's Title cell with its overall Course Critique GPA, based on courseMap.
 */
function updateCourseTitleCells() {
    const titleCells = document.querySelectorAll('td[data-property="courseTitle"]');

    for (const cell of titleCells) {
        const row = cell.closest('tr');

        // On a sections page (one row per section/instructor), each row's Instructor cell
        // already shows that specific professor's own GPA for this course - a second, course-
        // wide GPA chip here would just be a redundant second number right next to it. Only the
        // course-level results page (no Instructor column, one row per course) gets this block.
        if (row?.querySelector('td[data-property="instructor"]')) {
            const existingBlock = cell.querySelector('.cc-course-block');
            if (existingBlock) {
                existingBlock.remove();
            }
            delete cell.dataset.ccRenderKey;
            continue;
        }

        const courseID = row ? getCourseIDForRow(row) : null;

        if (!courseID || !courseMap.has(courseID)) {
            continue; // No resolvable course ID, or not yet fetched - nothing to render yet
        }

        // See the matching comment in updateProfessorRatings: skip rebuilding when nothing has
        // changed, so a hovered GPA chip stays a stable DOM node across Banner's own frequent
        // background re-renders instead of having its hover state yanked out from under it.
        const renderKey = courseID;
        if (cell.dataset.ccRenderKey === renderKey) {
            continue;
        }

        const existingBlock = cell.querySelector('.cc-course-block');
        if (existingBlock) {
            existingBlock.remove();
        }

        cell.appendChild(createCourseCritiqueBlock(courseID, courseMap.get(courseID)));
        cell.dataset.ccRenderKey = renderKey;
    }
}

/**
 * Callback function for the MutationObserver.
 * Detects changes in the DOM and processes new professor/course table elements.
 */
async function handleMutations() {
    // Rebuilding a chip (below) can yank it out from under the cursor mid-hover, which never
    // fires that chip's mouseleave and would otherwise leave the tooltip stuck on screen.
    hideCcTooltipIfAnchorDetached();

    const professorCells = document.querySelectorAll('td[data-property="instructor"]');
    const courseRows = Array.from(document.querySelectorAll('td[data-property="courseTitle"]'))
        .map((cell) => cell.closest('tr'))
        .filter(Boolean);

    if (professorCells.length > 0) {
        await processProfessorTables(professorCells);
    }
    if (courseRows.length > 0) {
        // Fetched before updateProfessorRatings() runs, so per-instructor Course Critique data
        // is available in courseMap by the time instructor cells render.
        await processCourseRows(courseRows);
    }
    if (professorCells.length > 0) {
        await updateProfessorRatings();
    }
    if (courseRows.length > 0) {
        updateCourseTitleCells();
    }
}

/**
 * Initializes the extension by setting up the MutationObserver.
 */
function initializeExtension() {
    // Set up the MutationObserver to observe changes anywhere within the document body,
    // not just its direct children (registration results render deep inside nested
    // containers, not as direct children of <body>).
    let isScanning = false;
    let rescanQueued = false;

    const observer = new MutationObserver(scheduleScan);

    /**
     * handleMutations() does real async work (network fetches), during which Banner can
     * navigate the user to an entirely new page (e.g. opening a class quickly). An earlier
     * version of this disconnected the observer for the duration of that fetch to avoid
     * reacting to its own DOM insertions, which created exactly that blind spot: a fast
     * navigation during the disconnected window was invisible, and nothing guaranteed a
     * follow-up scan once reconnected - symptomatically, statistics wouldn't appear until some
     * unrelated mutation happened to fire again (e.g. navigating back and re-opening the page).
     *
     * This never disconnects. A mutation that arrives while already scanning (including the
     * scan's own insertions, and any real navigation that happens mid-fetch) just queues one
     * follow-up pass instead of being missed or recursing unboundedly. Each pass is cheap when
     * nothing's actually new, since updateProfessorRatings/updateCourseTitleCells skip
     * rebuilding a cell whose render key hasn't changed - so the loop converges quickly once a
     * pass makes no further DOM changes of its own.
     */
    async function scheduleScan() {
        if (isScanning) {
            rescanQueued = true;
            return;
        }

        isScanning = true;
        try {
            do {
                rescanQueued = false;
                await handleMutations();
            } while (rescanQueued);
        } finally {
            isScanning = false;
        }
    }

    observer.observe(document.body, {childList: true, subtree: true});

    // Run an initial scan immediately in case the results table is already present
    // (e.g. on a page that was already loaded before this script attached).
    scheduleScan();
}

// Run the initialization when the content script loads
initializeExtension();