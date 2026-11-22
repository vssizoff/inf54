function encodedRequestUri(r) {
    return encodeURIComponent(r.variables.request_uri);
}

export default { encodedRequestUri };