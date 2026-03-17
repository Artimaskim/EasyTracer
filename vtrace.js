
// vtrace.js - A new, modern vector tracing engine.
// Final rewrite focusing on correct layering and smoothing.

window.vtrace = {
    trace: function(source, options = {}) {
        return new Promise(async (resolve, reject) => {
            try {
                const image = await loadImage(source);
                const svg = rasterToVectorSVG(image, options);
                resolve(svg);
            } catch (err) {
                console.error("Tracing failed:", err);
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
        img.onerror = () => reject(new Error('Could not load image for tracing.'));
        img.src = src;
    });
}

function rasterToVectorSVG(image, options) {
    const { ctx, width, height } = prepareCanvas(image, options);
    const imageData = ctx.getImageData(0, 0, width, height);

    const { palette, quantizedData } = quantizeColors(imageData, options);
    
    let allPaths = traceAllPaths(quantizedData, palette, width, height, options);
    
    allPaths.forEach(p => p.area = (p.bbox[2] - p.bbox[0]) * (p.bbox[3] - p.bbox[1]));
    allPaths.sort((a, b) => b.area - a.area);
    
    const svgPaths = processAndBuildPaths(allPaths, options);
    
    return assembleSVG(svgPaths, width, height);
}

function prepareCanvas(image, options) {
    const { width: iw, height: ih } = image;
    const maxDimension = 1200; 
    const scaleFactor = Math.min(1, maxDimension / Math.max(iw, ih));
    const width = Math.max(1, Math.round(iw * scaleFactor));
    const height = Math.max(1, Math.round(ih * scaleFactor));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const blurRadius = Number(options.blurradius) || 0;
    if (blurRadius > 0) {
        ctx.filter = `blur(${Math.min(10, Math.max(0, blurRadius))}px)`;
    }
    
    ctx.drawImage(image, 0, 0, width, height);
    return { ctx, width, height };
}

function quantizeColors(imageData, options) {
    const numberOfColors = Math.max(2, Math.min(256, options.numberofcolors || 16));
    const { data, width, height } = imageData;
    
    const pixels = [];
    const step = Math.max(1, Math.floor(Math.sqrt((width * height) / (numberOfColors * 5))));
    for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
            const i = (y * width + x) * 4;
            if (data[i + 3] > 128) {
                pixels.push([data[i], data[i+1], data[i+2]]);
            }
        }
    }

    if (pixels.length === 0) {
        return { palette: [{r:0,g:0,b:0,a:0}], quantizedData: new Int16Array(width*height).fill(-1) };
    }

    let centroids = pixels.slice(0, numberOfColors).map(p => [...p]);
    if (pixels.length < numberOfColors) {
        centroids = pixels.map(p=>[...p]);
    }

    let clusters = Array.from({ length: centroids.length }, () => []);
    for (let iter = 0; iter < 15; iter++) {
        clusters.forEach(c => c.length=0);
        for (const p of pixels) {
            let minDist = Infinity, clusterIndex = 0;
            for (let i = 0; i < centroids.length; i++) {
                const dist = (p[0] - centroids[i][0])**2 + (p[1] - centroids[i][1])**2 + (p[2] - centroids[i][2])**2;
                if (dist < minDist) { minDist = dist; clusterIndex = i; }
            }
            clusters[clusterIndex].push(p);
        }

        const newCentroids = centroids.map((_, i) => {
            if (clusters[i].length === 0) return centroids[i];
            const avg = clusters[i].reduce((acc, p) => [acc[0]+p[0], acc[1]+p[1], acc[2]+p[2]], [0,0,0]);
            return [avg[0]/clusters[i].length, avg[1]/clusters[i].length, avg[2]/clusters[i].length];
        });
        
        if (JSON.stringify(newCentroids) === JSON.stringify(centroids)) break;
        centroids = newCentroids;
    }

    const palette = [{r:0,g:0,b:0,a:0}, ...centroids.map(c => ({r:Math.round(c[0]), g:Math.round(c[1]), b:Math.round(c[2]), a:255}))];
    
    const quantizedData = new Int16Array(width * height);
    const findClosestColor = (r, g, b, pal) => {
        let minDist = Infinity, colorIndex = 0;
        for (let j = 1; j < pal.length; j++) {
            const p = pal[j];
            const dist = (r - p.r)**2 + (g - p.g)**2 + (b - p.b)**2;
            if (dist < minDist) { minDist = dist; colorIndex = j; }
        }
        return colorIndex;
    };
    
    for (let i = 0; i < data.length; i += 4) {
        const pixelIndex = i / 4;
        if (data[i + 3] < 128) {
            quantizedData[pixelIndex] = -1;
            continue;
        }
        quantizedData[pixelIndex] = findClosestColor(data[i], data[i+1], data[i+2], palette);
    }

    return { palette, quantizedData };
}

function traceAllPaths(quantizedData, palette, width, height, options) {
    const pathomit = Math.max(1, Number(options.pathomit) || 2);
    const allPaths = [];
    const memo = {}; // Memoization for contours

    for (let colorIndex = 1; colorIndex < palette.length; colorIndex++) {
        const contours = findContours(quantizedData, width, height, colorIndex, memo);
        if (contours.length === 0) continue;
        
        for (const contour of contours) {
            if (contour.points.length >= pathomit) {
                allPaths.push({
                    ...contour,
                    color: palette[colorIndex]
                });
            }
        }
    }
    return allPaths;
}

function findContours(data, width, height, colorIndex, memo) {
    const key = colorIndex;
    if (memo[key]) return memo[key];

    const contours = [];
    const visited = new Uint8Array(data.length);
    // Directions: N, NE, E, SE, S, SW, W, NW
    const DIRS = [[0,-1], [1,-1], [1,0], [1,1], [0,1], [-1,1], [-1,0], [-1,-1]];
    
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            if (visited[i] || data[i] !== colorIndex) continue;

            // Is this a boundary pixel? Check if a neighbor has a different color.
            let isBoundary = false;
            for(const d of DIRS) {
                if (data[(y+d[1])*width + (x+d[0])] !== colorIndex) {
                    isBoundary = true;
                    break;
                }
            }
            if(!isBoundary) continue;

            // Start tracing
            let sx = x, sy = y;
            let path = [];
            let bbox = [width, height, 0, 0];
            let lastDir = 0;
            let sanity = 0;

            while (sanity++ < 50000) {
                path.push([sx, sy]);
                visited[sy * width + sx] = 1;
                bbox[0] = Math.min(bbox[0], sx); bbox[1] = Math.min(bbox[1], sy);
                bbox[2] = Math.max(bbox[2], sx); bbox[3] = Math.max(bbox[3], sy);
                
                let foundNext = false;
                // Start search from where we came from (lastDir - 3)
                for (let j = 0; j < DIRS.length; j++) {
                    const dir = (lastDir + 5 + j) % 8; // (lastDir - 3 + j)
                    const nx = sx + DIRS[dir][0];
                    const ny = sy + DIRS[dir][1];
                    const ni = ny * width + nx;

                    if (nx >= 0 && nx < width && ny >= 0 && ny < height && data[ni] === colorIndex) {
                        sx = nx; sy = ny;
                        lastDir = dir;
                        foundNext = true;
                        break;
                    }
                }
                
                if (sx === x && sy === y) { break; } // Loop closed
                if (!foundNext) { break; } // Dead end
            }
            
            if (path.length > 2) {
                contours.push({ points: path, bbox });
            }
        }
    }
    memo[key] = contours;
    return contours;
}

function processAndBuildPaths(paths, options) {
    const { ltres = 0.5, qtres = 1, smoothamount = 0.5 } = options;

    // First pass: Simplify and smooth all paths
    const processedPaths = paths.map(p => {
        let points = p.points;
        if (smoothamount > 0 && points.length > 5) {
            points = smoothPath(points, smoothamount);
        }
        return {
            ...p,
            points: simplifyPath(points, ltres)
        };
    });
    
    // Build SVG path data string
    return processedPaths.map(p => {
        const color = p.color;
        const fill = `rgb(${color.r},${color.g},${color.b})`;
        const d = fitCurves(p.points, qtres);
        return `<path fill="${fill}" d="${d}"/>`;
    }).join('\n');
}

function smoothPath(points, amount) {
    const smoothed = [];
    const len = points.length;
    if (len < 3) return points;

    // Create a closed loop for averaging
    const closed = [...points, points[0], points[1]];
    const weight = amount * 0.5;
    const invWeight = 1 - amount;

    for (let i = 1; i <= len; i++) {
        const p_prev = closed[i - 1];
        const p_curr = closed[i];
        const p_next = closed[i + 1];
        const newX = p_curr[0] * invWeight + (p_prev[0] + p_next[0]) * weight;
        const newY = p_curr[1] * invWeight + (p_prev[1] + p_next[1]) * weight;
        smoothed.push([newX, newY]);
    }
    return smoothed;
}

function simplifyPath(points, tolerance) {
    if (points.length < 3) return points;
    let dmax = 0, index = 0;
    const end = points.length - 1;
    for (let i = 1; i < end; i++) {
        const d = perpendicularDistance(points[i], points[0], points[end]);
        if (d > dmax) { index = i; dmax = d; }
    }
    if (dmax > tolerance) {
        const res1 = simplifyPath(points.slice(0, index + 1), tolerance);
        const res2 = simplifyPath(points.slice(index), tolerance);
        return res1.slice(0, res1.length - 1).concat(res2);
    } else {
        return [points[0], points[end]];
    }
}

function perpendicularDistance(pt, p1, p2) {
    const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
    if (dx === 0 && dy === 0) return Math.hypot(pt[0] - p1[0], pt[1] - p1[1]);
    return Math.abs(dy * pt[0] - dx * pt[1] + p2[0] * p1[1] - p2[1] * p1[0]) / Math.hypot(dx, dy);
}

function fitCurves(points, maxError) {
    if (points.length < 2) return "";
    let pathData = `M${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)}`;
    if (points.length === 2) {
        pathData += `L${points[1][0].toFixed(2)} ${points[1][1].toFixed(2)}`;
    } else {
        const tangents = getTangents(points);
        for (let i = 0; i < points.length - 1; i++) {
            const p1 = points[i], p2 = points[i+1];
            const t1 = tangents[i], t2 = tangents[i+1];
            const d = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 3.0;
            const c1 = [p1[0] + t1[0] * d, p1[1] + t1[1] * d];
            const c2 = [p2[0] - t2[0] * d, p2[1] - t2[1] * d];
            pathData += `C${c1[0].toFixed(2)} ${c1[1].toFixed(2)} ${c2[0].toFixed(2)} ${c2[1].toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
        }
    }
    return pathData + "Z";
}

function getTangents(points) {
    const tangents = [];
    const n = points.length;
    for (let i = 0; i < n; i++) {
        const p_prev = points[(i - 1 + n) % n];
        const p_next = points[(i + 1) % n];
        let dx = p_next[0] - p_prev[0];
        let dy = p_next[1] - p_prev[1];
        const mag = Math.hypot(dx, dy);
        if (mag === 0) { dx=0; dy=0; } else { dx /= mag; dy /= mag; }
        tangents.push([dx, dy]);
    }
    return tangents;
}

function assembleSVG(svgPaths, width, height) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">
  <rect width="100%" height="100%" fill="transparent"/>
  ${svgPaths}
</svg>`;
}
