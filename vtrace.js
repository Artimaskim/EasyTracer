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
    if (options.autoshapes) {
        const detectedShapes = detectSimpleOvals(imageData, width, height, options);
        if (detectedShapes && detectedShapes.length > 0) {
            detectedShapePieces = detectedShapes.map(s => ` <ellipse cx="${s.cx.toFixed(2)}" cy="${s.cy.toFixed(2)}" rx="${s.rx.toFixed(2)}" ry="${s.ry.toFixed(2)}" fill="${s.fill}"/>`);
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

    if (allPieces.length === 0) {
        allPieces.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`);
    }

    return `<?xml version="1.0" encoding="UTF-8"?>\n`+
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">\n`+
        `  <rect width="100%" height="100%" fill="transparent"/>\n`+
        `  ${allPieces.join('\n')}\n</svg>`;
}

function tracePaths(imageData, width, height, options) {
    const ltres = Number(options.ltres) || 1;
    const qtres = Number(options.qtres) || 1;
    const pathOmit = Math.max(1, Number(options.pathomit) || 3);
    const linefilter = Boolean(options.linefilter);

    const indexedData = ImageTracer.getImgdata(width, height, imageData.data);
    const pal = ImageTracer.getPalette(options.numberofcolors || 16, indexedData);
    const colorQuantizedData = ImageTracer.colorquantization(indexedData, pal, options);
    const layerData = ImageTracer.layering(colorQuantizedData);
    const pathData = ImageTracer.batchpathscan(layerData, pathOmit);
    const interpPathData = ImageTracer.batchinterpollation(pathData, ltres, qtres);

    let svgPathStrs = [];
    interpPathData.forEach((layer) => {
        layer.forEach((path) => {
            if (linefilter && path.points.length < 4) return;
            const color = pal[path.colorid];
            if (!color || color.a < 32) return;
            const fill = `rgb(${color.r},${color.g},${color.b})`;
            if (path.points.length < 2) return;

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
            if (visited[i] || data[i * 4 + 3] < 128) continue;
            const blob = findConnectedComponent(imageData, width, height, x, y, visited);
            if (blob.points.length < 20 || blob.points.length > 50000) continue;
            const {minX, minY, maxX, maxY} = blob.bounds;
            const w = maxX - minX + 1, h = maxY - minY + 1;
            if (w < 10 || h < 10) continue;
            if (w / h < 0.5 || w / h > 2.0) continue;
            if (blob.points.length / (w*h) < 0.5) continue;
            if (blob.points.length / (Math.PI*(w/2)*(h/2)) < 0.7) continue;
            blobs.push({ cx:minX+w/2, cy:minY+h/2, rx:w/2, ry:h/2, fill:`rgb(${blob.avgColor.r},${blob.avgColor.g},${blob.avgColor.b})` });
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
    while (queue.length > 0) {
        const [x, y] = queue.shift();
        points.push([x,y]);
        const i = (y * width + x) * 4;
        sumR+=data[i]; sumG+=data[i+1]; sumB+=data[i+2];
        minX=Math.min(minX,x); minY=Math.min(minY,y); maxX=Math.max(maxX,x); maxY=Math.max(maxY,y);
        for(let dy=-1; dy<=1; dy++) for(let dx=-1; dx<=1; dx++) {
            if((dx===0&&dy===0) || (x+dx<0||x+dx>=width||y+dy<0||y+dy>=height)) continue;
            const ni = (y+dy)*width+(x+dx);
            if(visited[ni] || data[ni*4+3]<128) continue;
            const nc = {r:data[ni*4],g:data[ni*4+1],b:data[ni*4+2]};
            if(colorDist(startColor, nc)<64) { visited[ni]=1; queue.push([x+dx,y+dy]); }
        }
    }
    return { points, bounds:{minX,minY,maxX,maxY}, avgColor:{r:Math.round(sumR/points.length),g:Math.round(sumG/points.length),b:Math.round(sumB/points.length)} };
}

const ImageTracer = {
    getImgdata:(w,h,d)=>({width:w,height:h,data:d}),
    getPalette:(n,d)=>{const p=[{r:0,g:0,b:0,a:0}];for(let i=0;i<n;i++){const g=Math.floor(255*(i/(n-1)));p.push({r:g,g:g,b:g,a:255});}return p;},
    colorquantization:(d,p)=>{const data=d.data,id=new Array(d.width*d.height);for(let j=0;j<data.length;j+=4){if(data[j+3]<128){id[j/4]=-1;continue;}let c=-1,m=1e12;for(let i=0;i<p.length;i++){const di=Math.pow(p[i].r-data[j],2)+Math.pow(p[i].g-data[j+1],2)+Math.pow(p[i].b-data[j+2],2);if(di<m){m=di;c=i;}}id[j/4]=c;}return {...d,data:id,palette:p};},
    layering:(d)=>{const l=Array.from({length:d.palette.length},()=>Array.from({length:d.height},()=>new Array(d.width).fill(0)));for(let y=0;y<d.height;y++)for(let x=0;x<d.width;x++){const c=d.data[y*d.width+x];if(c!==-1)l[c][y][x]=1;}return l;},
    batchpathscan: (layers, pathomit) => layers.map((layer, i) => ImageTracer.pathscan(layer, pathomit).map(path => ({ ...path, colorid: i }))),
    pathscan:(a,p)=>{const ps=[],w=a[0].length,h=a.length;for(let r=0;r<h;r++)for(let c=0;c<w;c++)if(a[r][c]===1){let path={points:[],bbox:[c,r,c,r]},px=c,py=r,d=1;while(true){path.points.push([d,px,py]);a[py][px]=2;let n=ImageTracer.next_pixel(a,px,py,d);if(n.isend)break;px=n.px;py=n.py;d=n.nd;}if(path.points.length>=p)ps.push(path);}return ps;},
    next_pixel:(a,px,py,d)=>{const ds=[[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];for(let i=0;i<8;i++){const cd=(d+i+7)%8,nx=px+ds[cd][0],ny=py+ds[cd][1];if(nx>=0&&nx<a[0].length&&ny>=0&&ny<a.length&&a[ny][nx]===1)return{px:nx,py:ny,nd:cd,isend:false};}return{isend:true};},
    batchinterpollation:(p,lt,qt)=>p.map(l=>l.map(path=>({...path,points:ImageTracer.fitseq(path.points,lt,qt)}))),
    fitseq:(p,lt,qt)=>{if(p.length<3)return p.map(pt=>[1,pt[1],pt[2]]);const segs=[];for(let i=0;i<p.length;i++){const p1=(i>0)?p[i-1]:p[p.length-1],p2=p[i],p3=p[(i+1)%p.length];if((p2[1]===p1[1]&&p2[1]===p3[1])||(p2[2]===p1[2]&&p2[2]===p3[2]))segs.push([1,p2[1],p2[2]]);else segs.push(ImageTracer.fitcurve(p,i,qt));}return segs;},
    fitcurve:(p,i,qt)=>{const n=p.length,current=p[i],curve=[];const t=Math.min(Math.floor(n/2),10);if(t<1)return[1,current[1],current[2]];for(let j=1;j<=t;j++){const bz=ImageTracer.getbz(j/t,[p[(i-j+n)%n],current,p[(i+j)%n]]);const d=Math.sqrt(Math.pow(bz.x-current[1],2)+Math.pow(bz.y-current[2],2));if(d>qt)break;curve.push(bz);}if(curve.length===0)return[1,current[1],current[2]];const l=curve[curve.length-1];return[2,l.x,l.y,current[1],current[2]];},
    getbz:(t,pts)=>{const p0=pts[0],p1=pts[1],p2=pts[2];const x=(1-t)*(1-t)*p0[1]+2*(1-t)*t*p1[1]+t*t*p2[1];const y=(1-t)*(1-t)*p0[2]+2*(1-t)*t*p1[2]+t*t*p2[2];return{x,y};},
    pathnode_to_svg:{1:'L',2:'Q'},
};
