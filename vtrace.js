
// vtrace.js - lightweight vector tracing engine implementation.

window.vtrace = {
    trace: function(source, options = {}) {
        return new Promise(async (resolve, reject) => {
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
    const shapeSensitivity = Number(options.autoshapes) || 0;
    if (shapeSensitivity > 0) {
        const detectedShapes = detectSimpleOvals(imageData, width, height, options);
        if (detectedShapes && detectedShapes.length > 0) {
            detectedShapePieces = detectedShapes.map(s => ({ 
                svg: ` <ellipse cx="${s.cx.toFixed(2)}" cy="${s.cy.toFixed(2)}" rx="${s.rx.toFixed(2)}" ry="${s.ry.toFixed(2)}" fill="${s.fill}"/>`, 
                area: s.rx * s.ry * Math.PI 
            }));
            const data = imageData.data;
            detectedShapes.forEach(shape => {
                const { cx, cy, rx, ry } = shape;
                const minX=Math.floor(cx-rx), maxX=Math.ceil(cx+rx), minY=Math.floor(cy-ry), maxY=Math.ceil(cy+ry);
                for (let y=minY; y<=maxY; y++) for (let x=minX; x<=maxX; x++) {
                    if (x<0||y<0||x>=width||y>=height) continue;
                    if (((x-cx)*(x-cx)/(rx*rx))+((y-cy)*(y-cy)/(ry*ry))<=1.1) {
                        data[(y*width+x)*4+3] = 0;
                    }
                }
            });
        }
    }

    const pathPieces = tracePaths(imageData, width, height, options);
    const allPieces = [...detectedShapePieces, ...pathPieces];

    // Sort all pieces by area, descending. Largest first.
    allPieces.sort((a, b) => b.area - a.area);

    const svgElements = allPieces.map(p => p.svg);

    if (svgElements.length === 0) {
        svgElements.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`);
    }

    return `<?xml version="1.0" encoding="UTF-8"?>\n`+
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">\n`+
        `  <rect width="100%" height="100%" fill="transparent"/>\n`+
        `  ${svgElements.join('\n')}\n</svg>`;
}

function tracePaths(imageData, width, height, options) {
    const ltres = Number(options.ltres) || 1;
    const qtres = Number(options.qtres) || 1;
    const pathOmit = Math.max(1, Number(options.pathomit) || 3);
    const allowLines = options.hasOwnProperty('allowLines') ? options.allowLines : true;
    const allowQuadratic = options.hasOwnProperty('allowQuadratic') ? options.allowQuadratic : true;
    const smoothamount = Number(options.smoothamount) || 0;

    const indexedData = ImageTracer.getImgdata(width, height, imageData.data);
    const pal = ImageTracer.getPalette(options.numberofcolors || 16, indexedData);
    const colorQuantizedData = ImageTracer.colorquantization(indexedData, pal);
    const layerData = ImageTracer.layering(colorQuantizedData);
    
    let allPaths = ImageTracer.batchpathscan(layerData, pathOmit);

    if (smoothamount > 0) {
        allPaths = ImageTracer.batchsurfacesmoothing(allPaths, { smoothamount });
    }

    const interpPathData = ImageTracer.batchinterpollation(allPaths, { ltres, qtres, allowLines, allowQuadratic });

    return interpPathData.map(path => {
        const color = pal[path.colorid];
        if (!color || color.a < 32 || path.points.length < 2) return null;

        const fill = `rgb(${color.r},${color.g},${color.b})`;
        let pathStr = `M ${path.points[0][1].toFixed(3)} ${path.points[0][2].toFixed(3)} `;
        path.points.slice(1).forEach(p => {
            const command = ImageTracer.pathnode_to_svg[p[0]];
            if (command) {
                pathStr += `${command} `;
                p.slice(1).forEach(val => {
                    pathStr += (typeof val === 'number') ? `${val.toFixed(3)} ` : '0 ';
                });
            }
        });
        pathStr += "Z";
        
        const bbox = path.bbox;
        const area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]);

        return { 
            svg: `<path d="${pathStr}" fill="${fill}" stroke="none"/>`, 
            area: area
        };
    }).filter(p => p !== null);
}

function detectSimpleOvals(imageData, width, height, options) {
    const sensitivity = Number(options.autoshapes) || 0;
    const data = imageData.data;
    const visited = new Uint8Array(width * height);
    const blobs = [];

    const requiredFillRatio = 0.9 - (sensitivity * 0.45); // from 0.9 (very strict) down to 0.45 (very loose)
    const maxAspectRatio = 2.5 + (sensitivity * 2.5); // from 2.5 up to 5.0

    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = (y * width + x);
            if (visited[i] || data[i * 4 + 3] < 128) continue;
            
            const blob = findConnectedComponent(imageData, width, height, x, y, visited);
            if (blob.points.length < 50) continue; // Ignore very small blobs

            const {minX, minY, maxX, maxY} = blob.bounds;
            const w = maxX - minX + 1, h = maxY - minY + 1;
            if (w < 20 || h < 20) continue; // Ignore small shapes

            const aspectRatio = w > h ? w/h : h/w;
            if(aspectRatio > maxAspectRatio) continue;

            const ellipticalFillRatio = blob.points.length / (Math.PI * (w/2) * (h/2));
            if(ellipticalFillRatio < requiredFillRatio) continue;

            const shape = { cx:minX+w/2, cy:minY+h/2, rx:w/2, ry:h/2, fill:`rgb(${blob.avgColor.r},${blob.avgColor.g},${blob.avgColor.b})` };
            blobs.push(shape);
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
    let sumR=0, sumG=0, sumB=0, minX=width, minY=height, maxX=0, maxY=0;
    const colorDist = (c1, c2) => Math.sqrt(Math.pow(c1.r-c2.r,2) + Math.pow(c1.g-c2.g,2) + Math.pow(c1.b-c2.b,2));
    
    let head = 0;
    while(queue.length > head){
        const [x, y] = queue[head++];
        points.push([x,y]);
        const i = (y * width + x) * 4;
        sumR+=data[i]; sumG+=data[i+1]; sumB+=data[i+2];
        minX=Math.min(minX,x); minY=Math.min(minY,y); maxX=Math.max(maxX,x); maxY=Math.max(maxY,y);

        for(let dy=-1; dy<=1; dy++) for(let dx=-1; dx<=1; dx++) {
            if((dx===0&&dy===0) || (x+dx<0||x+dx>=width||y+dy<0||y+dy>=height)) continue;
            const ni = (y+dy)*width+(x+dx);
            if(visited[ni] || data[ni*4+3]<128) continue;
            const nc = {r:data[ni*4],g:data[ni*4+1],b:data[ni*4+2]};
            if(colorDist(startColor, nc) < 64) { 
                visited[ni]=1; 
                queue.push([x+dx,y+dy]); 
            }
        }
    }
    return { points, bounds:{minX,minY,maxX,maxY}, avgColor:{r:Math.round(sumR/points.length),g:Math.round(sumG/points.length),b:Math.round(sumB/points.length)} };
}


const ImageTracer = {
    getImgdata: (w, h, d) => ({ width: w, height: h, data: d }),

    getPalette: (numberOfColors, imgData) => {
        const { data, width, height } = imgData;
        const pixelArray = [];
        const step = Math.max(1, Math.floor(Math.sqrt(width * height / (numberOfColors * 4))));
        
        for (let y = 0; y < height; y += step) {
            for (let x = 0; x < width; x += step) {
                const i = (y * width + x) * 4;
                if (data[i + 3] > 127) {
                    pixelArray.push([data[i], data[i+1], data[i+2]]);
                }
            }
        }

        if (pixelArray.length === 0) return [{r:0,g:0,b:0,a:0}];

        if (pixelArray.length < numberOfColors) {
            return [{r:0,g:0,b:0,a:0}, ...pixelArray.map(p=>({r:p[0], g:p[1], b:p[2], a:255}))];
        }

        let centroids = pixelArray.slice(0, numberOfColors).map(p=>[...p]);
        for (let iter=0; iter<20; iter++) {
            const clusters = Array.from({ length: numberOfColors }, () => []);
            for (const p of pixelArray) {
                let minDist = Infinity, clusterIndex = 0;
                for (let i = 0; i < numberOfColors; i++) {
                    const dist = (p[0] - centroids[i][0])**2 + (p[1] - centroids[i][1])**2 + (p[2] - centroids[i][2])**2;
                    if (dist < minDist) { minDist = dist; clusterIndex = i; }
                }
                clusters[clusterIndex].push(p);
            }

            const newCentroids = centroids.map((_, i) => {
                if (clusters[i].length === 0) return pixelArray[Math.floor(Math.random()*pixelArray.length)];
                const avg = clusters[i].reduce((acc, p) => [acc[0]+p[0], acc[1]+p[1], acc[2]+p[2]], [0,0,0]);
                return [avg[0]/clusters[i].length, avg[1]/clusters[i].length, avg[2]/clusters[i].length];
            });
            
            if (JSON.stringify(newCentroids) === JSON.stringify(centroids)) break;
            centroids = newCentroids;
        }

        return [{r:0,g:0,b:0,a:0}, ...centroids.map(c => ({r: Math.round(c[0]), g: Math.round(c[1]), b: Math.round(c[2]), a: 255}))];
    },

    colorquantization: (d, p) => {
        const data = d.data;
        const id = new Array(d.width * d.height);
        for (let j = 0; j < data.length; j += 4) {
            if (data[j + 3] < 128) {
                id[j / 4] = -1;
                continue;
            }
            let c = 0, m = Infinity;
            for (let i = 1; i < p.length; i++) {
                const di = (p[i].r - data[j])**2 + (p[i].g - data[j + 1])**2 + (p[i].b - data[j + 2])**2;
                if (di < m) { m = di; c = i; }
            }
            id[j / 4] = c;
        }
        return { ...d, data: id };
    },

    layering: (d) => {
        const l = Array.from({ length: d.palette.length }, () => Array.from({ length: d.height }, () => new Array(d.width).fill(0)));
        for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) {
            const c = d.data[y * d.width + x];
            if (c !== -1) l[c][y][x] = 1;
        }
        return l;
    },

    batchpathscan: (layers, pathomit) => {
        let allPaths = [];
        layers.forEach((layer, i) => {
            const paths = ImageTracer.pathscan(layer, pathomit);
            paths.forEach(path => allPaths.push({ ...path, colorid: i }));
        });
        return allPaths;
    },

    pathscan: (a, p) => {
        const ps = [], w = a[0].length, h = a.length;
        for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) if (a[r][c] === 1) {
            let px = c, py = r, d = 1;
            const path = { points: [], bbox: [c, r, c, r] };
            while (true) {
                path.points.push([px, py]);
                a[py][px] = 2;
                if (px < path.bbox[0]) path.bbox[0] = px; if (px > path.bbox[2]) path.bbox[2] = px;
                if (py < path.bbox[1]) path.bbox[1] = py; if (py > path.bbox[3]) path.bbox[3] = py;

                let n = ImageTracer.next_pixel(a, px, py, d);
                if (n.isend) break;
                px = n.px; py = n.py; d = n.nd;
            }
            if (path.points.length >= p) ps.push(path);
        }
        return ps;
    },

    next_pixel: (a, px, py, d) => {
        const ds = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
        for (let i = 0; i < 8; i++) {
            const cd = (d + i + 7) % 8, nx = px + ds[cd][0], ny = py + ds[cd][1];
            if (nx >= 0 && nx < a[0].length && ny >= 0 && ny < a.length && a[ny][nx] === 1) return { px: nx, py: ny, nd: cd, isend: false };
        }
        return { isend: true };
    },

    batchsurfacesmoothing: (paths, opts) => {
        const smoothing = (opts && !isNaN(opts.smoothamount)) ? opts.smoothamount : 0;
        if (smoothing <= 0) return paths;

        return paths.map(path => {
            const { points } = path;
            if (points.length < 3) return path;
            const smoothedPoints = [];
            smoothedPoints.push(points[0]);
            for (let i = 1; i < points.length - 1; i++) {
                const prev = smoothedPoints[i-1];
                const current = points[i];
                const next = points[i+1];
                const newX = current[0] * (1-smoothing) + (prev[0] + next[0]) * (smoothing / 2);
                const newY = current[1] * (1-smoothing) + (prev[1] + next[1]) * (smoothing / 2);
                smoothedPoints.push([newX, newY]);
            }
            smoothedPoints.push(points[points.length-1]);
            path.points = smoothedPoints;
            return path;
        });
    },
    
    batchinterpollation: (p, opts) => p.map(path => ({ ...path, points: ImageTracer.fitseq(path.points, opts) })),

    fitseq: (points, opts) => {
        if (points.length < 2) return [];
        if (points.length === 2) {
            return [[1, points[0][0], points[0][1]], [1, points[1][0], points[1][1]]];
        }
        const segments = [];
        let i = 0;
        while (i < points.length - 1) {
            const [segment, endIndex] = ImageTracer.fitCurve(points, i, opts);
            segments.push(segment);
            i = endIndex;
        }
        segments.unshift([1, points[0][0], points[0][1]]);
        return segments;
    },

    fitCurve: (points, offset, opts) => {
        const slice = points.slice(offset);
        if (slice.length < 2) return [[1, slice[0][0], slice[0][1]], points.length - 1];

        if (opts.allowQuadratic) {
            for (let i = Math.min(slice.length - 1, 15); i >= 2; i--) {
                const curveSlice = slice.slice(0, i);
                const start = curveSlice[0];
                const end = curveSlice[curveSlice.length - 1];
                let maxError = 0, maxErrorIndex = 0;
                for (let j = 1; j < curveSlice.length - 1; j++) {
                    const error = ImageTracer.perpendicularDistance(curveSlice[j], start, end);
                    if (error > maxError) { maxError = error; maxErrorIndex = j; }
                }
                if (maxError < opts.qtres) {
                    const t = ImageTracer.findTForPoint(curveSlice[maxErrorIndex], start, end);
                    const control = ImageTracer.calculateControlPoint(t, curveSlice[maxErrorIndex], start, end);
                    return [[2, control[0], control[1], end[0], end[1]], offset + i - 1];
                }
            }
        }
        const end = slice[1];
        return [[1, end[0], end[1]], offset + 1];
    },

    perpendicularDistance: (p, p1, p2) => {
        const dx = p2[0] - p1[0];
        const dy = p2[1] - p1[1];
        if (dx === 0 && dy === 0) return Math.sqrt((p[0] - p1[0])**2 + (p[1] - p1[1])**2);
        return Math.abs(dy * p[0] - dx * p[1] + p2[0] * p1[1] - p2[1] * p1[0]) / Math.sqrt(dx * dx + dy * dy);
    },

    findTForPoint: (p, start, end) => {
        const d_sp = Math.sqrt((p[0]-start[0])**2 + (p[1]-start[1])**2);
        const d_se = Math.sqrt((end[0]-start[0])**2 + (end[1]-start[1])**2);
        return (d_se === 0) ? 0 : d_sp / d_se;
    },

    calculateControlPoint: (t, p, start, end) => {
        const rt = 1-t;
        const denominator = 2 * rt * t;
        if(denominator === 0) return [(start[0] + end[0])/2, (start[1] + end[1])/2];
        const x = (p[0] - rt*rt*start[0] - t*t*end[0]) / denominator;
        const y = (p[1] - rt*rt*start[1] - t*t*end[1]) / denominator;
        return [x, y];
    },

    getQuadraticBezierXY: (t, start, control, end) => {
        const rt = 1-t;
        const x = rt*rt*start[0] + 2*rt*t*control[0] + t*t*end[0];
        const y = rt*rt*start[1] + 2*rt*t*control[1] + t*t*end[1];
        return {x, y};
    },

    pathnode_to_svg: { 1: 'L', 2: 'Q' },
};
