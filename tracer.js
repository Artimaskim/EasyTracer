// tracer.js - abstraction layer for tracing engine.
// Current default: vtrace.

window.Tracer = {
    traceRasterToSVG: function(source, callback, options) {
        if (window.vtrace && typeof window.vtrace.trace === 'function') {
            try {
                const vtraceOptions = {
                    ...options
                };
                window.vtrace.trace(source, vtraceOptions)
                    .then(svgString => {
                        if (!svgString || typeof svgString !== 'string' || svgString.trim().length < 20) {
                            console.warn('vtrace returned empty/invalid SVG.');
                            callback('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><text x="10" y="20" fill="red">Trace failed</text></svg>');
                            return;
                        }
                        callback(svgString);
                    })
                    .catch(err => {
                        console.error('vtrace trace error', err);
                        callback('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><text x="10" y="20" fill="red">Trace failed</text></svg>');
                    });
            } catch (err) {
                console.error('vtrace integration failed', err);
                callback('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><text x="10" y="20" fill="red">Trace failed</text></svg>');
            }
        } else {
            callback('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><text x="10" y="20" fill="red">Engine unavailable</text></svg>');
        }
    }
};
