/**
 * Base URL for the Rate My Professors GraphQL API.
 * @type {string}
 */
URL = "https://www.ratemyprofessors.com/graphql";

/**
 * Publicly available authentication token for the Rate My Professors GraphQL API.
 * This token is publicly known and used in multiple open-source projects.
 * @type {string}
 */
AUTH_TOKEN = "dGVzdDp0ZXN0";

/**
 * Base64 encoded school ID for Georgia Institute of Technology.
 * @type {string}
 */
SCHOOL_ID = "U2Nob29sLTM2MQ==";

/**
 * Fetches professor data from the RMP GraphQL API and returns the ID of the first match.
 *
 * @param {string} professorName - The name of the professor to search for.
 * @returns {Promise<string|null>} A promise that resolves with the professor's ID (string) if found,
 *                                 or `null` if no matching professor is found (or if an error occurs.)
 */
async function getProfessorID(professorName) {
    const query = `
    query NewSearchTeachersQuery($name: String!, $schoolID: ID!) {
        newSearch {
          teachers(query: {text: $name, schoolID: $schoolID}) {
            edges {
              cursor
              node {
                id
                firstName
                lastName
                school {
                  name
                  id
                }
              }
            }
          }
        }
      }`; // GraphQL query to fetch professor data

    const variables = {
        name: professorName,
        schoolID: SCHOOL_ID
    }

    const options = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${AUTH_TOKEN}`
        },
        body: JSON.stringify({query, variables})
    };

    const [profFirstName, profLastName] = professorName.split(" ");

    // Get the ID of the most relevant professor from the API response
    try {
        const response = await fetch(URL, options);
        const data = await response.json();
        const edges = data?.data?.newSearch?.teachers?.edges;

        if (!edges || edges.length === 0) {
            return null; // No professor found in search results
        }

        const firstNode = edges[0].node;
        const firstNodeFirstName = firstNode.firstName.trim();
        const firstNodeLastName = firstNode.lastName.trim();


        // Verify that the first node matches the provided professor name
        if (!profFirstName.includes(firstNodeFirstName) || firstNodeLastName !== profLastName) {
            return null; // Professor name mismatch
        }

        // Handle cases with multiple search results for the same professor
        if (edges.length >= 2) {
            const secondNode = edges[1].node;
            const secondNodeFirstName = secondNode.firstName.trim();
            const secondNodeLastName = secondNode.lastName.trim();

            // Handle cases where a professor has two nodes
            if (firstNodeFirstName === secondNodeFirstName && firstNodeLastName === secondNodeLastName) {
                // Concurrently fetch metrics for both nodes
                const [firstMetrics, secondMetrics] = await Promise.all([
                    getProfessorMetrics(firstNode.id),
                    getProfessorMetrics(secondNode.id)
                ]);

                // Return the ID of the node with more ratings (or the first node if this number is equal)
                if (firstMetrics && secondMetrics) {
                    return firstMetrics.numRatings >= secondMetrics.numRatings ? firstNode.id : secondNode.id;
                }
            }
        }

        // Default: Return the first node's ID (if it passed the name check)
        return firstNode.id;

    } catch (error) {
        console.error("Error fetching professor ID:", error); // TODO: Consider removing/improving error handling
        return null; // Return null to indicate error
    }
}

/**
 * Retrieves detailed metrics for a professor from the RMP GraphQL API.
 *
 * @param {string} professorID - The RMP ID of the professor.
 * @returns {Promise<{Object}|null>} A promise that resolves with an object containing professor metrics
 *                                   or `null` if no professor is found with the given ID (or if an error
 *                                   occurs.) The metrics object has the following structure:
 *                                   {
 *                                      avgDifficulty: number,
 *                                      avgRating: number,
 *                                      numRatings: number,
 *                                      wouldTakeAgainPercent: number
 *                                   }
 */
async function getProfessorMetrics(professorID) {
    const query = `    
    query TeacherRatingsPageQuery($profID: ID!) {
        node(id: $profID) {
          ... on Teacher {
            id
            firstName
            lastName
            school {
              name
              id
              city
              state
            }
            avgDifficulty
            avgRating
            numRatings
            legacyId
            wouldTakeAgainPercent
          }
          id
        }
      }`; // GraphQL query to retrieve professor metrics

    const variables = {
        profID: professorID
    }

    const options = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${AUTH_TOKEN}`
        },
        body: JSON.stringify({query, variables})
    };

    try {
        const response = await fetch(URL, options);
        const data = await response.json();
        const node = data?.data?.node;

        if (node) {
            return {
                avgDifficulty: node.avgDifficulty,
                avgRating: node.avgRating,
                numRatings: node.numRatings,
                wouldTakeAgainPercent: node.wouldTakeAgainPercent
            };
        } else {
            return null;
        }
    } catch (error) {
        console.error("Error Fetching Professor Metrics:", error); // TODO: Consider removing/improving error handling
        return null;
    }
}

/**
 * Constructs the Rate My Professor link for a given professor ID.
 *
 * @param {string} professorID - The base64-encoded professor ID. When decoded, this string must be in the format
 *                               "Teacher-XXXXXXXX", where XXXXXXXX is the numeric ID.
 * @return {null|string} The Rate My Professor URL, or null if an error occurred during decoding.
 */
function getRMPProfessorLink(professorID) {
    try {
        const decodedProfID = atob(professorID); // Decode the base64 ID
        const binaryProfID = decodedProfID.replace("Teacher-", ""); // Extract numeric ID

        return `https://www.ratemyprofessors.com/professor/${binaryProfID}`;
    } catch (error) {
        console.error("Error decoding or constructing RateMyProfessor link"); // TODO: Consider removing/improving
        return null;
    }
}

/**
 * Retrieves professor metrics and includes the RateMyProfessor link for the professor.
 *
 * @param {string} professorID - The base64-encoded professor ID.
 * @return {Promise<{Object}|null>} A promise that resolves with an object containing the professor's metrics
 *                                  and RateMyProfessor link, or null if no metrics were found or if an error
 *                                  occurred. If successful, the returned object will have the following
 *                                  structure:
 *                                  {
 *                                      // ... other metrics (avgRating, avgDifficulty, etc.)
 *                                      RMPLink: string // The RateMyProfessor link
 *                                  }
 */
async function getProfessorMetricsWithLink(professorID) {
    const metrics = await getProfessorMetrics(professorID);

    if (metrics) {
        metrics.RMPLink = getRMPProfessorLink(professorID); // Add the RMP link to the metrics object
    }
    return metrics;
}

/**
 * Base URL for Georgia Tech Course Critique's backing data API.
 * @type {string}
 */
COURSE_CRITIQUE_API = "https://c4citk6s9k.execute-api.us-east-1.amazonaws.com/prod/data/course";

/**
 * Estimates a section's headcount from Course Critique's bucketed class-size-group label,
 * so per-section GPA/grade data can be combined into a weighted average instead of a plain
 * mean (a 200-student lecture section should count for more than a 10-student seminar).
 * Matches the weighting Course Critique's own site uses (via the gt-scheduler project, which
 * reverse-engineered it from this same API).
 *
 * @param {string} classSizeGroup - e.g. "Very Large (50 students or more)".
 * @return {number} An estimated section headcount.
 */
function sizeGroupWeight(classSizeGroup) {
    if (!classSizeGroup) {
        return 20;
    }
    if (classSizeGroup.includes("Very Small")) {
        return 5;
    }
    if (classSizeGroup.includes("Very Large")) {
        return 50;
    }
    if (classSizeGroup.includes("Small")) {
        return 15;
    }
    if (classSizeGroup.includes("Large")) {
        return 40;
    }
    if (classSizeGroup.includes("Mid")) {
        return 25;
    }
    return 20;
}

/**
 * Normalizes a Course Critique instructor name from "Lastname, Firstname" to
 * "Firstname Lastname", so it can be matched against the name already normalized from the
 * registration page's instructor cell.
 *
 * @param {string} name - e.g. "Stewart, Lauren".
 * @return {string} e.g. "Lauren Stewart", or the original name if it isn't in "Last, First" form.
 */
function normalizeCritiqueInstructorName(name) {
    const match = name.match(/^([\w'-]+(?:\s+[\w'-]+)*),\s*([\w'-]+)/);
    if (match) {
        const [, lastName, firstName] = match;
        return `${firstName} ${lastName}`;
    }
    return name;
}

/**
 * Aggregates an array of Course Critique's per-section rows into a single weighted-average
 * GPA and grade distribution.
 *
 * @param {Array<Object>} rows - Rows from the API's `raw` array (optionally filtered to one instructor).
 * @return {Object|null} `{avgGpa, dist: {A,B,C,D,F,W}, passRate, withdrawRate, sectionsCount}`,
 *                        or `null` if none of the rows had usable GPA data.
 */
function aggregateCritiqueRows(rows) {
    let gpaWeightSum = 0;
    let gpaNumerSum = 0;
    let distWeightSum = 0;
    const distNumer = {A: 0, B: 0, C: 0, D: 0, F: 0, W: 0};

    for (const row of rows) {
        const weight = sizeGroupWeight(row.class_size_group);

        if (typeof row.GPA === 'number') {
            gpaNumerSum += row.GPA * weight;
            gpaWeightSum += weight;
        }

        for (const key of Object.keys(distNumer)) {
            if (typeof row[key] === 'number') {
                distNumer[key] += row[key] * weight;
            }
        }
        distWeightSum += weight;
    }

    if (gpaWeightSum === 0) {
        return null;
    }

    const dist = {};
    for (const key of Object.keys(distNumer)) {
        dist[key] = distWeightSum > 0 ? Math.round((distNumer[key] / distWeightSum) * 10) / 10 : 0;
    }

    return {
        avgGpa: Math.round((gpaNumerSum / gpaWeightSum) * 100) / 100,
        dist,
        passRate: Math.max(0, Math.round((100 - dist.F - dist.W) * 10) / 10),
        withdrawRate: dist.W,
        sectionsCount: rows.length
    };
}

/**
 * Fetches and aggregates Course Critique data for a course, both overall and broken down
 * per instructor.
 *
 * @param {string} courseID - e.g. "PHYS 2212" (subject code + course number, space-separated).
 * @return {Promise<Object|null>} `{avgGpa, dist, passRate, withdrawRate, sectionsCount,
 *                                  byInstructor: {[name]: {avgGpa, dist, passRate, withdrawRate}},
 *                                  critiqueLink}`, or `null` if no data was found.
 */
async function getCourseCritiqueData(courseID) {
    try {
        const response = await fetch(`${COURSE_CRITIQUE_API}?courseID=${encodeURIComponent(courseID)}`);
        if (!response.ok) {
            return null;
        }

        const data = await response.json();
        if (!data || !Array.isArray(data.raw) || data.raw.length === 0) {
            return null;
        }

        const overall = aggregateCritiqueRows(data.raw);
        if (!overall) {
            return null;
        }

        const rowsByInstructor = new Map();
        for (const row of data.raw) {
            if (!row.instructor_name) {
                continue;
            }
            const name = normalizeCritiqueInstructorName(row.instructor_name);
            if (!rowsByInstructor.has(name)) {
                rowsByInstructor.set(name, []);
            }
            rowsByInstructor.get(name).push(row);
        }

        const byInstructor = {};
        for (const [name, rows] of rowsByInstructor) {
            const agg = aggregateCritiqueRows(rows);
            if (agg) {
                byInstructor[name] = agg;
            }
        }

        // Best/worst-GPA instructor is deliberately NOT computed here: this `byInstructor` map
        // spans every instructor Course Critique has ever recorded for the course, most of whom
        // likely aren't even teaching it this term. "Best/worst" needs to be scoped to whichever
        // instructors are actually showing up in the current search results, which only the
        // content script (which can see the live page) is in a position to compute.
        return {
            ...overall,
            byInstructor,
            critiqueLink: `https://critique.gatech.edu/course?courseID=${encodeURIComponent(courseID)}`
        };
    } catch (error) {
        console.error("Error fetching Course Critique data:", error); // TODO: Consider removing/improving error handling
        return null;
    }
}

/**
 * Event listener for establishing connection with the extension's content script.
 * Listens for messages containing professor names (RMP lookups) or course IDs (Course
 * Critique lookups), and responds on the same port with the corresponding data.
 */
chrome.runtime.onConnect.addListener(function(port) {
    port.onMessage.addListener(async function(msg) {
        if (msg.professorName) {
            const profID = await getProfessorID(msg.professorName);

            if (profID === null) {
                port.postMessage({professorMetrics: null});
                return;
            }

            const profMetrics = await getProfessorMetricsWithLink(profID);
            port.postMessage({professorMetrics: profMetrics});
        } else if (msg.courseID) {
            const courseCritiqueData = await getCourseCritiqueData(msg.courseID);
            port.postMessage({courseCritiqueData});
        } else {
            console.error("Error checking msg.professorName / msg.courseID"); // Log errors
        }
    });
});