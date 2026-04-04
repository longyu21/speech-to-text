export function parseBackendDateTime(value) {
    if (/z$/i.test(value) || /[+-]\d{2}:\d{2}$/.test(value)) {
        return new Date(value);
    }
    return new Date(`${value}Z`);
}
export function formatBackendDateTime(value) {
    return parseBackendDateTime(value).toLocaleString();
}
