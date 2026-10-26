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

// Store processed professor names as keys and their metrics as values
const profMap = new Map();

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
 * Processes an array of table elements containing professor names.
 * retrieves metrics for each professor, and updates the `profMap`.
 *
 * @param {NodeListOf<Element>} tables - An array of table elements (<td>) representing professor names.
 * @param {number} retryCount - The current retry attempt count (used internally for reconnections).
 * @returns {Promise<void>} A promise that resolves when all professors have been processed.
 */
async function processProfessorTables(tables, retryCount = 0) {
    for (const element of tables) {
        let professorName = element.textContent.trim();

        // Check for empty table cells BEFORE normalization
        if (professorName.length === 0) {
            continue; // Skip to the next iteration if professor name is blank
        }

        // Normalize the professor's name
        professorName = normalizeProfessorName(professorName);

        // Check if the normalized name has already been processed
        if (profMap.has(professorName)) {
            continue; // Skip to the next iteration
        }

        try {
            const metrics = await getProfessorMetrics(professorName);
            profMap.set(professorName, metrics);
        } catch (error) {
            if (error.message.includes('Extension context invalidated.')) {
                window.location.reload(); // Refresh the current tab to re-inject the content script
                return; // Exit the function early as further processing will fail
            }

            if (error.message.includes('Attempting to use a disconnected port object')) {
                // The connection to the background script has been lost
                if (retryCount >= MAX_RETRIES) {
                    console.error(`Max retries (${MAX_RETRIES}) exceeded. Refreshing page.`);
                    window.location.reload();
                    return;
                }
                // Attempt to reconnect to the background script and retry processing the professor tables
                port = chrome.runtime.connect({name: "professorMetrics"});
                return await processProfessorTables(tables, retryCount + 1);
            }

            profMap.set(professorName, null); // Store null to indicate failure
        }
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
 * Creates the anchor linking to a professor's RateMyProfessor page.
 *
 * @param {string} RMPLink - The link to the professor's RateMyProfessor page.
 * @return {HTMLAnchorElement} The created anchor element.
 */
function createRMPLinkAnchor(RMPLink) {
    const RMPLinkAnchor = document.createElement('a');
    RMPLinkAnchor.href = RMPLink;
    RMPLinkAnchor.textContent = "RMP »";
    RMPLinkAnchor.title = "View on RateMyProfessors";
    RMPLinkAnchor.target = "_blank";
    return RMPLinkAnchor;
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
function createRatingElement(metrics) {
    const ratingDiv = document.createElement('div');
    ratingDiv.className = 'rmp-rating-box';

    // Handle cases where the professor page does not exist
    if (metrics === null) {
        ratingDiv.appendChild(createSpan("No page found.", "rmp-no-data"));
        return ratingDiv; // Return early if no metrics found
    }

    // Handle cases where the professor has a page but no ratings have been submitted yet.
    // Showing 0/5 stats (or a link to an essentially empty page) here would be misleading.
    if (metrics.numRatings === 0) {
        ratingDiv.appendChild(createSpan("No ratings yet.", "rmp-no-data"));
        return ratingDiv;
    }

    // The overall rating is the headline stat: an icon + the bare number, bold and
    // color-coded by quality so it reads at a glance.
    const overallClass = `rmp-rating-overall ${getRatingColorClass(metrics.avgRating)}`;
    ratingDiv.appendChild(createStatLine(ICON_STAR, `${metrics.avgRating}`, overallClass));
    ratingDiv.appendChild(document.createElement('br'));

    // Remaining stats stay muted and icon-prefixed, labels unchanged for now.
    ratingDiv.appendChild(createStatLine(ICON_DIFFICULTY, `Difficulty: ${metrics.avgDifficulty} / 5`, "rmp-secondary"));
    ratingDiv.appendChild(document.createElement('br'));
    ratingDiv.appendChild(createStatLine(ICON_RATINGS_COUNT, `Total Ratings: ${metrics.numRatings}`, "rmp-secondary"));
    ratingDiv.appendChild(document.createElement('br'));

    // wouldTakeAgainPercent can still be -1 (not enough responses to that specific question)
    // even when other ratings exist.
    if (metrics.wouldTakeAgainPercent === -1) {
        ratingDiv.appendChild(createStatLine(ICON_TAKE_AGAIN, "Take again: N/A", "rmp-secondary"));
    } else {
        const roundedPercentage = Math.round(metrics.wouldTakeAgainPercent);
        ratingDiv.appendChild(createStatLine(ICON_TAKE_AGAIN, `Take again: ${roundedPercentage}%`, "rmp-secondary"));
    }

    ratingDiv.appendChild(document.createElement('br'));

    // Create and append link to the professor's RateMyProfessor page
    ratingDiv.appendChild(createRMPLinkAnchor(metrics.RMPLink));

    return ratingDiv;
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
 * Updates the displayed professor ratings based on the profMap.
 */
async function updateProfessorRatings() {
    const professorCells = document.querySelectorAll('td[data-property="instructor"]');

    for (const cell of professorCells) {
        const professorName = normalizeProfessorName(cell.textContent.trim());

        // Remove any existing rating div elements from the cell to prevent duplicates
        const existingRatings = cell.querySelector('div');
        if (existingRatings) {
            existingRatings.remove();
        }

        if (!professorName) { // Skip empty cells
            continue;
        }

        const metrics = profMap.get(professorName);
        const ratingElement = createRatingElement(metrics);
        insertRating(cell, ratingElement);
    }
}

/**
 * Callback function for the MutationObserver.
 * Detects changes in the DOM and processes new professor table elements.
 */
async function handleMutations() {
    const tables = document.querySelectorAll('td[data-property="instructor"]');

    if (tables.length > 0) {
        await processProfessorTables(tables);
        await updateProfessorRatings(); // Insert professor ratings into the DOM after processing new tables
    }
}

/**
 * Initializes the extension by setting up the MutationObserver.
 */
function initializeExtension() {
    // Set up the MutationObserver to observe changes anywhere within the document body,
    // not just its direct children (registration results render deep inside nested
    // containers, not as direct children of <body>).
    //
    // handleMutations() itself inserts/removes rating elements, which are mutations within
    // this same subtree. Without guarding against that, each scan would trigger another
    // scan indefinitely. To avoid this, the observer is disconnected before each scan and
    // reconnected afterward, discarding any mutation records generated by the scan's own
    // DOM updates before resuming observation.
    const observer = new MutationObserver(runScan);

    async function runScan() {
        observer.disconnect();
        try {
            await handleMutations();
        } finally {
            observer.takeRecords();
            observer.observe(document.body, {childList: true, subtree: true});
        }
    }

    // Run an initial scan immediately in case the results table is already present
    // (e.g. on a page that was already loaded before this script attached).
    runScan();
}

// Run the initialization when the content script loads
initializeExtension();