// vtrace.js - lightweight vector tracing engine implementation.

window.vtrace = {
    trace: function(source, options = {}) {
        return new Promise(async (resolve, reject) => {
            if (window.ImageTracer && typeof window.ImageTracer.imageToSVG === 'function') {
                try {
                    window.ImageTracer.imageToSVG(source, (svgString) => {
                        if (!svgString || typeof svgString !== 'string' || svgString.trim().length === 0) {
                            reject(new Error('ImageTracer returned empty SVG.'));
                            return;
                        }
                        resolve(svgString);
                    }, options);
                    return;
                } catch (err) {
                    console.error('ImageTracer error inside vtrace:', err);
                }
            }
            try {
                const image = await loadImage(source);
                const svg = rasterToVectorSVG(image, options);
                resolve(svg);
            } catch (err) {
                reject(err);
            }
        });
    }
};

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = (e) => reject(new Error('Невозможно загрузить изображение для трассировки.'));
        img.src = src;
    });
}

function rasterToVectorSVG(image, options) {
    const { width: iw, height: ih } = image;
    const maxDimension = 1400;
    const scaleFactor = Math.min(1, maxDimension / Math.max(iw, ih));
    const width = Math.max(1, Math.round(iw * scaleFactor));
    const height = Math.max(1, Math.round(ih * scaleFactor));

    console.log('rasterToVectorSVG: image dimensions', { iw, ih, width, height });

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas context не доступен.');

    const blurRadius = Number(options.blurradius) || 0;
    ctx.filter = blurRadius > 0 ? `blur(${Math.min(15, Math.max(0, blurRadius))}px)` : 'none';
    ctx.drawImage(image, 0, 0, width, height);

    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;

    console.log('rasterToVectorSVG: raw image data sample (top-left pixel)', data.slice(0, 4));

    if (options.autoShapes) {
        const ells = detectSimpleOvals(imageData, width, height, options);
        if (ells && ells.length > 0) {
            const pieces = ells.map((e) => ` <ellipse cx="${e.cx}" cy="${e.cy}" rx="${e.rx}" ry="${e.ry}" fill="${e.fill}" stroke="${e.stroke}" stroke-width="${e.strokeWidth}" stroke-linecap="round" stroke-linejoin="round" />`);
            return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">${pieces.join('')}\n</svg>`;
        }
    }

    const colorLevels = Math.max(2, Math.min(64, Number(options.numberofcolors) || 16));
    const qtres = Number(options.qtres) || 1;
    const ltres = Number(options.ltres) || 1;
    const cellSize = Math.max(1, Math.round(Math.min(16, (qtres + ltres) / 2)));
    const pathOmit = Math.max(1, Number(options.pathomit) || 3);
    const rightangleenhance = Boolean(options.rightangleenhance);
    const linefilter = Boolean(options.linefilter);

    const rects = [];
    for (let y = 0; y < height; y += cellSize) {
        for (let x = 0; x < width; x += cellSize) {
            let rAcc = 0, gAcc = 0, bAcc = 0, aAcc = 0, count = 0;
            for (let yy = y; yy < Math.min(height, y + cellSize); yy++) {
                for (let xx = x; xx < Math.min(width, x + cellSize); xx++) {
                    const idx = (yy * width + xx) * 4;
                    rAcc += data[idx];
                    gAcc += data[idx + 1];
                    bAcc += data[idx + 2];
                    aAcc += data[idx + 3];
                    count += 1;
                }
            }
            if (count === 0) continue;
            const r = Math.round(rAcc / count);
            const g = Math.round(gAcc / count);
            const b = Math.round(bAcc / count);
            const a = Math.round(aAcc / count);

            const fill = a < 20 ? 'transparent' : `rgb(${Math.round(rAcc/count)},${Math.round(gAcc/count)},${Math.round(bAcc/count)})`;

            if (a < 20 && fill === 'transparent') {
                // Only add if it's explicitly transparent and not just skipped
                rects.push({ x, y, w: cellSize, h: cellSize, fill, gray: 255, area: cellSize * cellSize });
                continue;
            }

            const gray = (0.299 * r + 0.587 * g + 0.114 * b);
            if (gray > 250 && a > 20) continue; // Skip only very bright non-transparent pixels.

            const quant = (value) => {
                const step = 255 / (colorLevels - 1);
                return Math.round(Math.round(value / step) * step);
            };

            const qr = quant(r);
            const qg = quant(g);
            const qb = quant(b);
            const quantizedFill = `rgb(${qr},${qg},${qb})`;
            rects.push({ x, y, w: cellSize, h: cellSize, fill: quantizedFill, gray, area: cellSize * cellSize });
        }
    }

    console.log('rasterToVectorSVG: initial rects count', rects.length);

    if (rects.length === 0) {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#eee"/></svg>`;
    }

    const simplified = [];
    if (rightangleenhance) {
        const rowMap = new Map();
        rects.forEach(r => {
            const k = `${r.y}:${r.fill}`;
            let row = rowMap.get(k);
            if (!row) {
                row = [];
                rowMap.set(k, row);
            }
            row.push(r);
        });
        rowMap.forEach(row => {
            row.sort((a, b) => a.x - b.x);
            let current = null;
            row.forEach(r => {
                if (!current) {
                    current = { ...r };
                    return;
                }
                if (r.x <= current.x + current.w + 1 && r.fill === current.fill && r.y === current.y) {
                    current.w = Math.max(current.w, (r.x + r.w) - current.x);
                } else {
                    simplified.push(current);
                    current = { ...r };
                }
            });
            if (current) simplified.push(current);
        });
    } else {
        simplified.push(...rects);
    }

    console.log('rasterToVectorSVG: simplified rects count', simplified.length);

    const svgPieces = [];
    let keep = 0;
    for (const r of simplified) {
        if (linefilter && (r.w < 2 || r.h < 2)) continue;
        if (pathOmit > 1 && r.area < cellSize * pathOmit) continue;
        svgPieces.push(`<rect x=\"${r.x}\" y=\"${r.y}\" width=\"${r.w}\" height=\"${r.h}\" fill=\"${r.fill}\" stroke=\"none\"/>`);
        keep += 1;
        if (keep > 30000) break;
    }

    console.log('rasterToVectorSVG: svgPieces count', svgPieces.length);

    // Ensure at least one shape exists to prevent empty vector output.
    if (svgPieces.length === 0) {
        svgPieces.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`);
    }

    const svg = `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">` +
        `${svgPieces.join('')}\n</svg>`;
    console.log('rasterToVectorSVG: final svg string length', svg.length);
    return svg;
}
function detectSimpleOvals(imageData, width, height, options) {
    const data = imageData.data;
    const threshold = 200;
    const visited = new Uint8Array(width * height);
    const blobs = [];

    const idx = (x, y) => y * width + x;

    for (let y = 0; y < height; y += 2) {
        for (let x = 0; x < width; x += 2) {
            const i = idx(x, y);
            if (visited[i]) continue;
            const alpha = data[(y * width + x) * 4 + 3];
            if (alpha < 30) continue;
            const r = data[(y * width + x) * 4];
            const g = data[(y * width + x) * 4 + 1];
            const b = data[(y * width + x) * 4 + 2];
            const gray = 0.299 * r + 0.587 * g + 0.114 * b;
            if (gray > threshold) continue;

            const queue = [[x, y]];
            const points = [];
            visited[i] = 1;

            while (queue.length) {
                const [cx, cy] = queue.pop();
                points.push([cx, cy]);
                for (let oy = -1; oy <= 1; oy++) {
                    for (let ox = -1; ox <= 1; ox++) {
                        const nx = cx + ox;
                        const ny = cy + oy;
                        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                        const ni = idx(nx, ny);
                        if (visited[ni]) continue;
                        const na = data[(ny * width + nx) * 4 + 3];
                        if (na < 30) continue;
                        const nr = data[(ny * width + nx) * 4];
                        const ng = data[(ny * width + nx) * 4 + 1];
                        const nb = data[(ny * width + nx) * 4 + 2];
                        const ngray = 0.299 * nr + 0.587 * ng + 0.114 * nb;
                        if (ngray > threshold) continue;
                        visited[ni] = 1;
                        queue.push([nx, ny]);
                    }
                }
            }

            if (points.length < 30) continue;
            let minX = width, minY = height, maxX = 0, maxY = 0;
            points.forEach(p => {
                minX = Math.min(minX, p[0]);
                minY = Math.min(minY, p[1]);
                maxX = Math.max(maxX, p[0]);
                maxY = Math.max(maxY, p[1]);
            });
            const w = maxX - minX + 1;
            const h = maxY - minY + 1;
            if (w < 10 || h < 10) continue;
            const ratio = w / h;
            if (ratio < 0.6 || ratio > 1.7) continue;
            const area = points.length;
            const expected = Math.PI * (w / 2) * (h / 2);
            if (area < expected * 0.25) continue;

            blobs.push({
                cx: minX + w / 2,
                cy: minY + h / 2,
                rx: w / 2,
                ry: h / 2,
                fill: 'none',
                stroke: '#000',
                strokeWidth: 2
            });

            if (blobs.length >= 5) break;
        }
        if (blobs.length >= 5) break;
    }

    return blobs;
}
