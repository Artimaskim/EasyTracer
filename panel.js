document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const uploadBox = document.getElementById('upload-box');
    const fileInput = document.getElementById('file-input');
    const urlInput = document.getElementById('url-input');
    const imageBox = document.getElementById('image-box');
    const originalImage = document.getElementById('original-image');
    const svgContainer = document.getElementById('svg-container');
    const previewPanel = document.getElementById('preview-panel');
    const modeLabel = document.getElementById('mode-label');
    const traceBtn = document.getElementById('trace-btn');
    const clearBtn = document.getElementById('clear-btn');
    const clearAllBtn = document.getElementById('clear-all-btn');
    const saveSvgBtn = document.getElementById('save-svg-btn');
    const copyClipboardBtn = document.getElementById('copy-clipboard-btn');
    const closeViewBtn = document.getElementById('close-view-btn');
    const tooltipPopup = document.getElementById('tooltip-popup');
    const settingsPanel = document.getElementById('settings-panel');

    function updateSettingIndicators(){
        const inputs = settingsPanel.querySelectorAll('input, select');
        inputs.forEach(input => {
            const indicator = settingsPanel.querySelector(`.value-indicator[data-target='${input.id}']`);
            if (indicator) {
                if (input.tagName === 'SELECT'){
                    indicator.textContent = input.options[input.selectedIndex].text;
                } else {
                    indicator.textContent = input.value;
                }
            }
        });
    }

    function attachInfoIconTooltips(){
        let tooltipTimer = null;
        document.querySelectorAll('.info-icon').forEach(icon => {
            icon.addEventListener('mouseenter', (e) => {
                tooltipTimer = setTimeout(() => {
                    tooltipPopup.textContent = icon.getAttribute('data-tip') || 'Info not available.';
                    const rect = icon.getBoundingClientRect();
                    tooltipPopup.style.left = `${rect.left + rect.width / 2}px`;
                    tooltipPopup.style.top = `${rect.bottom + 8}px`;
                    tooltipPopup.style.display = 'block';
                }, 350);
            });
            icon.addEventListener('mouseleave', () => {
                clearTimeout(tooltipTimer);
                tooltipPopup.style.display = 'none';
            });
            icon.addEventListener('click', (e) => e.stopPropagation());
        });
        document.addEventListener('click', () => { tooltipPopup.style.display = 'none'; });
    }

    let scale = 1, panX = 0, panY = 0, dragStart = null;
    let createdObjectURL = null, isShowingVector = false, hasTraced = false;

    const cleanupObjectURL = () => { if(createdObjectURL) { URL.revokeObjectURL(createdObjectURL); createdObjectURL = null; } };

    function saveTextFile(filename, text){
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    function renderSVGString(svgString){
        if (!svgString || typeof svgString !== 'string') return false;
        const cleaned = svgString.replace(/^\s*<\?xml[^>]*>\s*/i, '').trim();
        if (!cleaned) return false;
        svgContainer.innerHTML = cleaned;
        return svgContainer.querySelector('svg');
    }

    const saveSVG = () => {
        const svg = svgContainer.querySelector('svg');
        if(svg) saveTextFile('trace.svg', svg.outerHTML);
        else alert('No resulting SVG. Trace first.');
    };

    async function copyToClipboard(){
        const svg = svgContainer.querySelector('svg');
        if(!svg) { alert('No SVG to copy.'); return; }
        try {
            await navigator.clipboard.writeText(svg.outerHTML);
            alert('SVG copied to clipboard.');
        } catch (err) {
            alert('Failed to copy SVG.');
        }
    }

    function updateTransform() {
        const image = originalImage;
        const svg = svgContainer.querySelector('svg');
        const containerWidth = previewPanel.clientWidth, containerHeight = previewPanel.clientHeight;
        const naturalWidth = image.naturalWidth, naturalHeight = image.naturalHeight;
        const fitScale = Math.min(containerWidth / naturalWidth, containerHeight / naturalHeight, 1);
        const transform = `translate(-50%, -50%) translate(${panX}px, ${panY}px) scale(${scale * fitScale})`;

        const applyStyles = (el) => {
            if(!el) return;
            Object.assign(el.style, {
                position: 'absolute', top: '50%', left: '50%',
                transformOrigin: 'center center', transform: transform,
                width: `${naturalWidth}px`, height: `${naturalHeight}px`
            });
        };
        applyStyles(image); applyStyles(svg);
    }

    function updateViewMode(){
        const svg = svgContainer.querySelector('svg');
        const hasValidSvg = svg && svg.children.length > 0;
        modeLabel.textContent = (isShowingVector && hasValidSvg) ? 'Vector' : 'Raster';
        originalImage.style.opacity = (isShowingVector && hasValidSvg) ? '0' : '1';
        svgContainer.style.display = (isShowingVector && hasValidSvg) ? 'block' : 'none';
        closeViewBtn.style.display = originalImage.src ? 'block' : 'none';
    }

    function showImage(url) {
        cleanupObjectURL();
        if (url.startsWith('blob:')) createdObjectURL = url;
        originalImage.src = url;
        originalImage.onload = () => {
            Object.assign(window, {scale: 1, panX: 0, panY: 0});
            updateTransform();
        };
        svgContainer.innerHTML = '';
        uploadBox.style.display = 'none';
        imageBox.style.display = 'flex';
        [traceBtn, clearBtn, clearAllBtn].forEach(b => b.disabled = false);
        [saveSvgBtn, copyClipboardBtn].forEach(b => b.disabled = true);
        Object.assign(window, {isShowingVector: false, hasTraced: false});
        traceBtn.textContent = 'Trace';
        updateViewMode();
    }

    function clearImage() {
        cleanupObjectURL();
        originalImage.src = '';
        svgContainer.innerHTML = '';
        [urlInput, fileInput].forEach(i => i.value = '');
        uploadBox.style.display = 'flex';
        imageBox.style.display = 'none';
        [traceBtn, clearBtn, clearAllBtn, saveSvgBtn, copyClipboardBtn].forEach(b => b.disabled = true);
        Object.assign(window, {scale: 1, panX: 0, panY: 0, isShowingVector: false, hasTraced: false});
        traceBtn.textContent = 'Trace';
        updateTransform();
        updateViewMode();
    }

    urlInput.addEventListener('change', async (e) => {
        const url = e.target.value.trim();
        if (!url) return;
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error('Network error.');
            const blob = await res.blob();
            showImage(URL.createObjectURL(blob));
        } catch (error) {
            alert('Could not load image from URL.');
        }
    });

    fileInput.addEventListener('change', () => {
        if (fileInput.files[0]) showImage(URL.createObjectURL(fileInput.files[0]));
    });
    
    const setupDragAndDrop = (el, handler) => {
        el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('dragover'); });
        el.addEventListener('dragleave', () => el.classList.remove('dragover'));
        el.addEventListener('drop', e => {
            e.preventDefault();
            el.classList.remove('dragover');
            if (e.dataTransfer.files[0]) handler(URL.createObjectURL(e.dataTransfer.files[0]));
        });
    };
    setupDragAndDrop(uploadBox, showImage);
    setupDragAndDrop(imageBox, showImage);
    
    clearBtn.addEventListener('click', () => {
        svgContainer.innerHTML = '';
        isShowingVector = false;
        updateViewMode();
        [saveSvgBtn, copyClipboardBtn].forEach(b => b.disabled = true);
        traceBtn.textContent = 'Trace';
    });
    clearAllBtn.addEventListener('click', clearImage);
    saveSvgBtn.addEventListener('click', saveSVG);
    copyClipboardBtn.addEventListener('click', copyToClipboard);
    closeViewBtn.addEventListener('click', clearImage);

    let isPanning = false;
    previewPanel.addEventListener('mousedown', e => {
        if (e.button !== 0 || !originalImage.src) return;
        isPanning = true;
        dragStart = { x: e.clientX, y: e.clientY, panX, panY };
        previewPanel.style.cursor = 'grabbing';
        if (svgContainer.querySelector('svg')) {
            isShowingVector = false;
            updateViewMode();
        }
    });
    window.addEventListener('mouseup', e => {
        if (e.button !== 0 || !isPanning) return;
        isPanning = false;
        previewPanel.style.cursor = 'grab';
        if (svgContainer.querySelector('svg')) {
            isShowingVector = true;
            updateViewMode();
        }
    });
    window.addEventListener('mousemove', e => {
        if (!isPanning) return;
        panX = dragStart.panX + (e.clientX - dragStart.x);
        panY = dragStart.panY + (e.clientY - dragStart.y);
        updateTransform();
    });
    
    traceBtn.addEventListener('click', () => {
        if (!originalImage.src) return;

        traceBtn.disabled = true;
        traceBtn.textContent = 'Tracing...';
        svgContainer.innerHTML = '';

        setTimeout(() => {
            const options = {};
            settingsPanel.querySelectorAll('input, select').forEach(input => {
                options[input.name] = (input.type === 'checkbox') ? input.checked : parseFloat(input.value);
            });
            
            vtrace.trace(originalImage.src, options)
                .then(svgString => {
                    const svg = renderSVGString(svgString);
                    isShowingVector = !!svg && svg.children.length > 0;
                    updateTransform();
                    updateViewMode();
                    hasTraced = true;
                    traceBtn.textContent = 'Retrace';
                    [saveSvgBtn, copyClipboardBtn, traceBtn].forEach(b => b.disabled = false);
                })
                .catch(err => {
                    console.error('Tracing error:', err);
                    alert('Error during tracing. Try adjusting settings.');
                    traceBtn.disabled = false;
                    traceBtn.textContent = hasTraced ? 'Retrace' : 'Trace';
                });
        }, 50);
    });

    previewPanel.addEventListener('wheel', e => {
        if (!originalImage.src) return;
        e.preventDefault();
        const zoomSpeed = 1.1;
        scale *= (e.deltaY > 0) ? (1 / zoomSpeed) : zoomSpeed;
        scale = Math.max(0.1, Math.min(20, scale));
        updateTransform();
    });

    settingsPanel.addEventListener('input', updateSettingIndicators);
    
    attachInfoIconTooltips();
    clearImage();
    updateSettingIndicators();
});
