/* global CustomFunctions */

const BRIDGE = "https://localhost:3998";

async function fetchQty(path) {
  try {
    const resp = await fetch(`${BRIDGE}${path}`);
    if (!resp.ok) return new CustomFunctions.Error(CustomFunctions.ErrorCode.notAvailable, `HTTP ${resp.status}`);
    const json = await resp.json();
    if (json.error) return new CustomFunctions.Error(CustomFunctions.ErrorCode.notAvailable, String(json.error));
    return json.value ?? 0;
  } catch {
    return new CustomFunctions.Error(CustomFunctions.ErrorCode.notAvailable, "StudIQ offline");
  }
}

/**
 * Returns the live quantity for a StudIQ dimension group.
 * @customfunction
 * @param {number} groupId  Dimension group ID
 * @param {string} [display] length, area, wall_area, volume, count, perimeter
 * @returns {number}
 */
async function STUDIQ_QTY(groupId, display) {
  const d = display || "length";
  return fetchQty(`/api/quantity?groupId=${encodeURIComponent(groupId)}&display=${encodeURIComponent(d)}`);
}

/**
 * Returns the live quantity for a single StudIQ measurement.
 * @customfunction
 * @param {number} groupId  Dimension group ID
 * @param {number} measurementId  Measurement ID (shown in the StudIQ task pane)
 * @param {string} [display] length, area, wall_area, volume, count
 * @returns {number}
 */
async function STUDIQ_MEASUREMENT(groupId, measurementId, display) {
  const d = display || "length";
  return fetchQty(
    `/api/measurement?groupId=${encodeURIComponent(groupId)}&measurementId=${encodeURIComponent(measurementId)}&display=${encodeURIComponent(d)}`
  );
}

/**
 * Returns the matching-timber lineal metres for a framing group (excludes lintels).
 * @customfunction
 * @param {number} groupId  Timber-framing dimension group ID
 * @returns {number}
 */
async function STUDIQ_FRAMING(groupId) {
  return fetchQty(`/api/framing_size?groupId=${encodeURIComponent(groupId)}`);
}

/**
 * Returns the total lineal metres for a specific lintel size in a framing group.
 * @customfunction
 * @param {number} groupId  Timber-framing dimension group ID
 * @param {string} size  Lintel size string, e.g. "140x45"
 * @returns {number}
 */
async function STUDIQ_LINTEL(groupId, size) {
  return fetchQty(
    `/api/lintel_size?groupId=${encodeURIComponent(groupId)}&size=${encodeURIComponent(size)}`
  );
}

/**
 * Returns the unit rate for a StudIQ rate library entry.
 * @customfunction
 * @param {number} id  Rate ID (shown in the StudIQ task pane)
 * @returns {number}
 */
async function STUDIQ_RATE(id) {
  return fetchQty(`/api/rate?id=${encodeURIComponent(id)}`);
}

/**
 * Returns the value of a named project constant.
 * @customfunction
 * @param {string} name  Constant name (e.g. "GFA")
 * @returns {number}
 */
async function STUDIQ_CONST(name) {
  return fetchQty(`/api/constant?name=${encodeURIComponent(name)}`);
}

CustomFunctions.associate("QTY", STUDIQ_QTY);
CustomFunctions.associate("MEASUREMENT", STUDIQ_MEASUREMENT);
CustomFunctions.associate("FRAMING", STUDIQ_FRAMING);
CustomFunctions.associate("LINTEL", STUDIQ_LINTEL);
CustomFunctions.associate("RATE", STUDIQ_RATE);
CustomFunctions.associate("CONST", STUDIQ_CONST);
