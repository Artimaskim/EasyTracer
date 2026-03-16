// vtrace.js - lightweight vector tracing engine implementation.

window.vtrace = {
    trace: function(source, options = {}) {
        return new Promise(async (resolve, reject) => {
            // Main tracing logic
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
        img.onerror = (e) => reject(new Error('Could not load image for tracing.'));
        img.src = src;
    });
}

function rasterToVectorSVG(image, options) {
    const { width: iw, height: ih } = image;
    const maxDimension = 1400;
    const scaleFactor = Math.min(1, maxDimension / Math.max(iw, ih));
    const width = Math.max(1, Math.round(iw * scaleFactor));
    const height = Math.max(1, Math.round(ih * scaleFactor));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas context is not available.');

    const blurRadius = Number(options.blurradius) || 0;
    ctx.filter = blurRadius > 0 ? `blur(${Math.min(15, Math.max(0, blurRadius))}px)` : 'none';
    ctx.drawImage(image, 0, 0, width, height);

    const imageData = ctx.getImageData(0, 0, width, height);
    
    let detectedShapePieces = [];
    // --- HYBRID TRACING: AUTO-SHAPES --- 
    if (options.autoshapes) {
        const detectedShapes = detectSimpleOvals(imageData, width, height, options);
        if (detectedShapes && detectedShapes.length > 0) {
            detectedShapePieces = detectedShapes.map(s => ` <ellipse cx="${s.cx.toFixed(2)}" cy="${s.cy.toFixed(2)}" rx="${s.rx.toFixed(2)}" ry="${s.ry.toFixed(2)}" fill="${s.fill}"/>`);
            
            // "Erase" the detected shapes from imageData to prevent re-tracing
            const data = imageData.data;
            detectedShapes.forEach(shape => {
                const { cx, cy, rx, ry } = shape;
                const minX = Math.floor(cx - rx);
                const maxX = Math.ceil(cx + rx);
                const minY = Math.floor(cy - ry);
                const maxY = Math.ceil(cy + ry);

                for (let y = minY; y <= maxY; y++) {
                    for (let x = minX; x <= maxX; x++) {
                        if (x < 0 || y < 0 || x >= width || y >= height) continue;
                        
                        if ( ( (x-cx)*(x-cx) / (rx*rx) ) + ( (y-cy)*(y-cy) / (ry*ry) ) <= 1.1 ) {
                            const idx = (y * width + x) * 4;
                            data[idx] = 255; data[idx + 1] = 255; data[idx + 2] = 255; data[idx + 3] = 0;
                        }
                    }
                }
            });
        }
    }

    // --- MAIN TRACING: PATH-BASED --- 
    const pathPieces = tracePaths(imageData, width, height, options);
    const allPieces = [...detectedShapePieces, ...pathPieces];

    if (allPieces.length === 0) {
        allPieces.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`);
    }

    const svg = `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">\n` +
        `  <rect width="100%" height="100%" fill="transparent"/>\n` +
        `  ${allPieces.join('\n')}\n</svg>`;
    
    return svg;
}

function tracePaths(imageData, width, height, options) {
    const data = imageData.data;
    const colorLevels = Math.max(2, Math.min(64, Number(options.numberofcolors) || 16));
    const qtres = Number(options.qtres) || 1;
    const ltres = Number(options.ltres) || 1;
    const pathOmit = Math.max(1, Number(options.pathomit) || 3);
    const linefilter = Boolean(options.linefilter);

    const indexedData = ImageTracer.getImgdata(width, height, data);
    const pal = ImageTracer.getPalette(colorLevels, indexedData);
    const colorQuantizedData = ImageTracer.colorquantization(indexedData, pal, options);
    const layerData = ImageTracer.layering(colorQuantizedData);
    const pathData = ImageTracer.batchpathscan(layerData, pathOmit);
    const interpPathData = ImageTracer.batchinterpollation(pathData, ltres, qtres);

    let svgPathStrs = [];
    interpPathData.forEach((layer, layerIdx) => {
        layer.forEach((path, pathIdx) => {
            if(linefilter && path.points.length < 4) return;
            const color = pal[path.colorid];
            if (!color || color.a < 32) return;
            const fill = `rgb(${color.r},${color.g},${color.b})`;

            let pathStr = `M ${path.points[0][1].toFixed(3)} ${path.points[0][2].toFixed(3)} `;
            path.points.slice(1).forEach(p => {
                pathStr += `${ImageTracer.pathnode_to_svg[p[0]]} `;
                p.slice(1).forEach(val => { pathStr += `${val.toFixed(3)} `; });
            });
            pathStr += "Z";
            svgPathStrs.push(`<path d="${pathStr}" fill="${fill}" stroke="none"/>`);
        });
    });
    return svgPathStrs;
}

function detectSimpleOvals(imageData, width, height, options) {
    const data = imageData.data;
    const visited = new Uint8Array(width * height);
    const blobs = [];
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = (y * width + x);
            if (visited[i]) continue;
            if (data[i * 4 + 3] < 128) continue;

            const blob = findConnectedComponent(imageData, width, height, x, y, visited);
            if (blob.points.length < 20 || blob.points.length > 50000) continue;
            const {minX, minY, maxX, maxY} = blob.bounds;
            const w = maxX - minX + 1, h = maxY - minY + 1;
            if (w < 10 || h < 10) continue;
            const ratio = w / h;
            if (ratio < 0.5 || ratio > 2.0) continue;
            const area = blob.points.length, bboxArea = w * h, density = area / bboxArea;
            if (density < 0.5) continue;
            const expectedEllipseArea = Math.PI * (w / 2) * (h / 2);
            const areaRatio = area / expectedEllipseArea;
            if (areaRatio < 0.7 || areaRatio > 1.3) continue;

            blobs.push({ cx: minX + w/2, cy: minY + h/2, rx: w/2, ry: h/2, fill: `rgb(${blob.avgColor.r},${blob.avgColor.g},${blob.avgColor.b})` });
            if (blobs.length >= 20) break;
        }
        if (blobs.length >= 20) break;
    }
    return blobs;
}

function findConnectedComponent(imageData, width, height, startX, startY, visited) {
    const data = imageData.data;
    const startIdx = (startY * width + startX) * 4;
    const startColor = { r: data[startIdx], g: data[startIdx+1], b: data[startIdx+2] };
    const queue = [[startX, startY]];
    const points = [];
    visited[startY * width + startX] = 1;
    let sumR = 0, sumG = 0, sumB = 0;
    let minX = width, minY = height, maxX = 0, maxY = 0;
    const colorDist = (c1, c2) => Math.sqrt(Math.pow(c1.r - c2.r, 2) + Math.pow(c1.g - c2.g, 2) + Math.pow(c1.b - c2.b, 2));

    while (queue.length > 0) {
        const [x, y] = queue.shift();
        points.push([x,y]);
        const i = (y * width + x) * 4;
        const r = data[i], g = data[i+1], b = data[i+2];
        sumR += r; sumG += g; sumB += b;
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        
        for(let dy = -1; dy <= 1; dy++) {
            for(let dx = -1; dx <= 1; dx++) {
                if(dx === 0 && dy === 0) continue;
                const nx = x + dx, ny = y + dy;
                if(nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                const ni = ny * width + nx;
                if(visited[ni]) continue;
                if(data[ni * 4 + 3] < 128) continue;
                const neighborColor = { r: data[ni*4], g: data[ni*4+1], b: data[ni*4+2] };
                if(colorDist(startColor, neighborColor) < 64) {
                    visited[ni] = 1;
                    queue.push([nx, ny]);
                }
            }
        }
    }
    return { points, bounds: { minX, minY, maxX, maxY }, avgColor: { r: Math.round(sumR/points.length), g: Math.round(sumG/points.length), b: Math.round(sumB/points.length) } };
}

// --- Minimal ImageTracer Polyfill (for path finding) ---
const ImageTracer = {
    getImgdata: (w, h, data) => ({ width: w, height: h, data: data }),
    getPalette: (numColors, imgd) => {
        const data = imgd.data, pal = [];
        for(let i=0; i<numColors; i++){
            const gray = Math.floor(255 * (i / (numColors-1)));
            pal.push({ r:gray, g:gray, b:gray, a:255 });
        }
        return pal;
    },
    colorquantization: (imgd, pal, options) => {
        const data = imgd.data, id = new Array(imgd.width*imgd.height);
        for(let j=0; j<data.length; j+=4){
            if(data[j+3] < 128){ id[j/4] = -1; continue; }
            let closest = -1, mindist = 1e12;
            for(let i=0; i<pal.length; i++){
                const dist = Math.pow(pal[i].r-data[j],2) + Math.pow(pal[i].g-data[j+1],2) + Math.pow(pal[i].b-data[j+2],2);
                if(dist < mindist){ mindist = dist; closest = i; }
            }
            id[j/4] = closest;
        }
        return { ...imgd, data: id, palette: pal };
    },
    layering: (imgd) => {
        const layers = Array.from({length: imgd.palette.length}, () => Array.from({length: imgd.height}, () => new Array(imgd.width).fill(0)));
        for(let y=0; y<imgd.height; y++){
            for(let x=0; x<imgd.width; x++){
                const c = imgd.data[y*imgd.width+x];
                if(c !== -1){ layers[c][y][x] = 1; }
            }
        }
        return layers;
    },
    batchpathscan: (layers, pathomit) => layers.map((layer, i) => ImageTracer.pathscan(layer, pathomit).map(path => ({...path, colorid: i})) ),
    pathscan: (arr, pathomit) => {
        const paths = [], w = arr[0].length, h = arr.length;
        for(let r=0; r<h; r++){
            for(let c=0; c<w; c++){
                if(arr[r][c] === 1){
                    let path = { points:[], boundingbox:[c,r,c,r], holechildren:[] }, px=c,py=r,dir=1;
                    while(true){
                        arr[py][px] = 2;
                        let np = ImageTracer.next_pixel(arr,px,py,dir);
                        if(np.isend) break;
                        path.points.push([dir, np.px, np.py]);
                        px=np.px; py=np.py; dir=np.nd;
                    }
                    if(path.points.length >= pathomit) paths.push(path);
                }
            }
        }
        return paths;
    },
    next_pixel: (arr,px,py,dir) => {
        const dirs = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];
        for(let i=0; i<8; i++){
            let cdir = (dir+i) % 8, nx = px+dirs[cdir][0], ny = py+dirs[cdir][1];
            if(nx>=0 && nx<arr[0].length && ny>=0 && ny<arr.length && arr[ny][nx]===1) return { px:nx, py:ny, nd:(cdir+4)%8, isend:false };
        }
        return { isend:true };
    },
    batchinterpollation: (layers, ltres, qtres) => layers.map(layer => layer.map(path => ({ ...path, points: ImageTracer.fitseq(path.points, ltres, qtres) }))),
    fitseq: (points, ltres, qtres) => {
        if(points.length < 3) return points.map(p=>[1,p[1],p[2]]);
        const segments = [], spl = points.length;
        for(let i=0; i<spl; i++){
            let p = (i>0) ? points[i-1] : points[spl-1];
            let c = points[i], n = points[(i+1)%spl];
            if( (c[1]===p[1] && c[1]===n[1]) || (c[2]===p[2] && c[2]===n[2]) ){
                segments.push([1, c[1], c[2]]); // Line segment
            } else {
                segments.push(ImageTracer.fitCurve(points, i, qtres));
            }
        }
        return segments;
    },
    fitCurve: (points, i, qtres) => {
        const p = points, n = p.length, t = Math.min(Math.floor(n/2), 20);
        const curve = [p[i]];
        for(let j=1; j<=t; j++){
            let f = j/t;
            let bz = ImageTracer.getBezier(f, [p[(i-j+n)%n], p[i], p[(i+j)%n]]);
            let d = Math.sqrt(Math.pow(bz.x-p[i][1], 2) + Math.pow(bz.y-p[i][2], 2));
            if(d > qtres) break;
            curve.push([3, bz.x, bz.y, bz.x, bz.y, bz.x, bz.y]);
        }
        return [3, curve[curve.length-1][1],curve[curve.length-1][2],curve[curve.length-1][3],curve[curve.length-1][4],curve[curve.length-1][5],curve[curve.length-1][6]];
    },
    getBezier: (t,pts) => {
        let p0=pts[0], p1=pts[1], p2=pts[2], x, y;
        x = (1-t)*(1-t)*p0[1] + 2*(1-t)*t*p1[1] + t*t*p2[1];
        y = (1-t)*(1-t)*p0[2] + 2*(1-t)*t*p1[2] + t*t*p2[2];
        return { x, y };
    },
    pathnode_to_svg: { 1:'L', 2:'Q', 3:'C' },
};
