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
    const engineLabel = document.getElementById('engine-label');
    
    const traceBtn = document.getElementById('trace-btn');
    const clearBtn = document.getElementById('clear-btn');
    const clearAllBtn = document.getElementById('clear-all-btn');
    const saveSvgBtn = document.getElementById('save-svg-btn');
    const copyClipboardBtn = document.getElementById('copy-clipboard-btn');
    const closeViewBtn = document.getElementById('close-view-btn');
    const tooltipPopup = document.getElementById('tooltip-popup');

    const lineFitToleranceSelect = document.getElementById('line-fit-tolerance');
    const settingsInputs = document.querySelectorAll('#settings-panel input, #settings-panel select');

    function getToleranceSettings() {
        const tolerance = lineFitToleranceSelect.value;
        switch (tolerance) {
            case 'coarse':
                return { ltres: 5, qtres: 5 };
            case 'fine':
                return { ltres: 0.8, qtres: 0.8 };
            case 'super-fine':
                return { ltres: 0.5, qtres: 0.5 };
            case 'medium':
            default:
                return { ltres: 1, qtres: 1 };
        }
    }

    function setSettingIndicators(){
        settingsInputs.forEach(input => {
            const label = document.querySelector(`label[for="${input.id}"]`);
            const indicator = label?.querySelector('.value-indicator');
            if (indicator) {
                if (input.type === 'range' || input.type === 'number') {
                    indicator.textContent = input.value;
                } else if (input.type === 'checkbox') {
                    indicator.textContent = input.checked ? 'on' : 'off';
                }
            }

            input.addEventListener('input', () => {
                const label2 = document.querySelector(`label[for="${input.id}"]`);
                const indicator2 = label2?.querySelector('.value-indicator');
                if (indicator2) {
                     if(input.tagName === 'SELECT'){
                        indicator2.textContent = input.options[input.selectedIndex].text;
                     } else {
                        indicator2.textContent = input.value;
                     }
                }
            });
        });
    }

    function attachInfoIconTooltips(){
        let tooltipTimer = null;

        document.querySelectorAll('.info-icon').forEach(icon => {
            icon.addEventListener('mouseenter', (e) => {
                tooltipTimer = setTimeout(() => {
                    const message = icon.getAttribute('data-tip') || 'Info not available.';
                    tooltipPopup.textContent = message;
                    const rect = icon.getBoundingClientRect();
                    const x = rect.left + rect.width / 2;
                    const y = rect.bottom + 8;
                    tooltipPopup.style.left = `${x}px`;
                    tooltipPopup.style.top = `${y}px`;
                    tooltipPopup.style.display = 'block';
                }, 350);
            });

            icon.addEventListener('mouseleave', () => {
                clearTimeout(tooltipTimer);
                tooltipPopup.style.display = 'none';
            });

            icon.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        });

        document.addEventListener('click', () => {
            tooltipPopup.style.display = 'none';
        });
    }

    // --- STATE ---
    let scale = 1;
    const minScale = 0.1;
    const maxScale = 20;
    let panX = 0;
    let panY = 0;
    let dragStart = null;
    let createdObjectURL = null;
    let isShowingVector = false;
    let hasTraced = false;

    function cleanupObjectURL(){
        if(createdObjectURL){
            URL.revokeObjectURL(createdObjectURL);
            createdObjectURL = null;
        }
    }

    function saveTextFile(filename, text){
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function renderSVGString(svgString){
        if (!svgString || typeof svgString !== 'string') return false;
        const cleaned = svgString.replace(/^\s*<\?xml[^>]*>\s*/i, '').trim();
        if (!cleaned) return false;

        const parser = new DOMParser();
        const doc = parser.parseFromString(cleaned, 'image/svg+xml');
        const svg = doc.querySelector('svg');
        if (!svg) {
            console.error('Parsed SVG contains no <svg>.');
            return false;
        }

        svgContainer.innerHTML = '';
        svgContainer.appendChild(svg);
        return true;
    }

    function saveSVG(){
        const svg = svgContainer.querySelector('svg');
        if(!svg){
            alert('No resulting SVG. Trace first.');
            return;
        }
        const svgText = svg.outerHTML;
        saveTextFile('trace.svg', svgText);
    }

    async function copyToClipboard(){
        const svg = svgContainer.querySelector('svg');
        if(!svg){
            alert('No resulting SVG. Trace first.');
            return;
        }
        const svgText = svg.outerHTML;
        try {
            await navigator.clipboard.writeText(svgText);
            alert('SVG copied to clipboard. Paste as text or save file.');
        } catch (err) {
            console.error('Clipboard write failed', err);
            alert('Failed to copy SVG. Try saving the file.');
        }
    }

    // --- FUNCTIONS ---

    function updateTransform() {
        const image = originalImage;
        const svg = svgContainer.querySelector('svg');
        const containerWidth = previewPanel.clientWidth || 500;
        const containerHeight = previewPanel.clientHeight || 400;
        const naturalWidth = image.naturalWidth || image.width || containerWidth;
        const naturalHeight = image.naturalHeight || image.height || containerHeight;
        const fitScale = Math.min(containerWidth / naturalWidth, containerHeight / naturalHeight, 1);
        const transform = `translate(-50%, -50%) translate(${panX}px, ${panY}px) scale(${scale * fitScale})`;

        const baseStyles = {
            position: 'absolute',
            top: '50%',
            left: '50%',
            transformOrigin: 'center center'
        };

        if (image) {
            Object.assign(image.style, baseStyles);
            image.style.width = `${naturalWidth}px`;
            image.style.height = `${naturalHeight}px`;
            image.style.maxWidth = '100%';
            image.style.maxHeight = '100%';
            image.style.transform = transform;
        }
        if (svg) {
            Object.assign(svg.style, baseStyles);
            svg.style.width = `${naturalWidth}px`;
            svg.style.height = `${naturalHeight}px`;
            svg.style.maxWidth = '100%';
            svg.style.maxHeight = '100%';
            svg.style.transform = transform;
        }
    }

    function updateViewMode(){
        const svg = svgContainer.querySelector('svg');
        const hasValidSvg = svg && svg.children.length > 0;

        if (modeLabel) {
            modeLabel.textContent = (isShowingVector && hasValidSvg) ? 'Vector' : 'Raster';
        }
        if(isShowingVector && hasValidSvg){
            originalImage.style.opacity = '0';
            svgContainer.style.display = 'block';
            if (closeViewBtn) closeViewBtn.style.display = 'block';
        } else {
            originalImage.style.opacity = '1';
            svgContainer.style.display = 'none';
            if (closeViewBtn) closeViewBtn.style.display = originalImage.src ? 'block' : 'none';
        }
    }

    function showImage(url) {
        cleanupObjectURL();
        if (url.startsWith('blob:')) {
            createdObjectURL = url;
        }
        originalImage.src = url;
        originalImage.draggable = false;
        originalImage.onload = () => {
            updateTransform();
        };
        svgContainer.innerHTML = '';
        uploadBox.style.display = 'none';
        imageBox.style.display = 'flex';
        traceBtn.disabled = false;
        clearBtn.disabled = false;
        clearAllBtn.disabled = false;
        saveSvgBtn.disabled = true;
        if (copyClipboardBtn) copyClipboardBtn.disabled = true;
        updateTransform();
        isShowingVector = false;
        hasTraced = false;
        traceBtn.textContent = 'Trace';
        panX = 0;
        panY = 0;
        if (closeViewBtn) closeViewBtn.style.display = 'none';
        updateViewMode();
    }

    function requestImageLoad(url) {
        showImage(url);
    }

    function clearTraceResult() {
        svgContainer.innerHTML = '';
        isShowingVector = false;
        updateViewMode();
        saveSvgBtn.disabled = true;
        if (copyClipboardBtn) copyClipboardBtn.disabled = true;
        clearAllBtn.disabled = false;
    }

    function clearImage() {
        cleanupObjectURL();

        originalImage.src = '';
        svgContainer.innerHTML = '';
        isShowingVector = false;
        hasTraced = false;
        traceBtn.textContent = 'Trace';
        urlInput.value = '';
        fileInput.value = '';
        uploadBox.style.display = 'flex';
        imageBox.style.display = 'none';
        traceBtn.disabled = true;
        clearBtn.disabled = true;
        saveSvgBtn.disabled = true;
        if (copyClipboardBtn) copyClipboardBtn.disabled = true;
        clearAllBtn.disabled = true;
        scale = 1;
        panX = 0;
        panY = 0;
        updateTransform();
        updateViewMode();
    }

    // --- EVENT LISTENERS ---

    urlInput.addEventListener('change', async (e) => {
        const url = e.target.value.trim();
        if (url) {
            try {
                const response = await fetch(url);
                if (!response.ok) throw new Error('Network response was not ok.');
                const blob = await response.blob();
                const objectURL = URL.createObjectURL(blob);
                requestImageLoad(objectURL);
            } catch (error) {
                console.error('Error fetching image from URL:', error);
                alert('Could not load image from URL. Check the link and CORS policy.');
            }
        }
    });
    urlInput.addEventListener('click', (e) => e.stopPropagation());

    uploadBox.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (e) => requestImageLoad(e.target.result);
            reader.readAsDataURL(file);
        }
    });

    uploadBox.addEventListener('dragover', (e) => { e.preventDefault(); uploadBox.classList.add('dragover'); });
    uploadBox.addEventListener('dragleave', () => { uploadBox.classList.remove('dragover'); });
    uploadBox.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadBox.classList.remove('dragover');
        const file = e.dataTransfer.files[0];
        if (file && file.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = (e) => requestImageLoad(e.target.result);
            reader.readAsDataURL(file);
        }
    });

    imageBox.addEventListener('dragstart', (e) => { e.preventDefault(); });
    imageBox.addEventListener('dragover', (e) => { e.preventDefault(); imageBox.classList.add('dragover'); });
    imageBox.addEventListener('dragleave', () => { imageBox.classList.remove('dragover'); });
    imageBox.addEventListener('drop', (e) => {
        e.preventDefault();
        imageBox.classList.remove('dragover');
        const file = e.dataTransfer.files[0];
        if (file && file.type.startsWith('image/')) {
            requestImageLoad(URL.createObjectURL(file));
        }
    });
    
    clearBtn.addEventListener('click', () => {
        clearTraceResult();
        traceBtn.textContent = 'Trace';
    });
    clearAllBtn.addEventListener('click', clearImage);
    saveSvgBtn.addEventListener('click', saveSVG);
    if (copyClipboardBtn) {
        copyClipboardBtn.addEventListener('click', copyToClipboard);
    }
    if (closeViewBtn) {
        closeViewBtn.addEventListener('click', clearImage);
    }

    let isPanning = false;
    previewPanel.addEventListener('dragstart', (e) => { e.preventDefault(); });
    previewPanel.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        const svg = svgContainer.querySelector('svg');
        if (svg) {
            isShowingVector = false;
            updateViewMode();
        }
        isPanning = true;
        dragStart = { x: e.clientX, y: e.clientY, panX, panY };
        previewPanel.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', (e) => {
        if (!isPanning || !dragStart) return;
        panX = dragStart.panX + (e.clientX - dragStart.x);
        panY = dragStart.panY + (e.clientY - dragStart.y);
        updateTransform();
    });
    window.addEventListener('mouseup', (e) => {
        if (e.button !== 0) return;
        if (isPanning) {
            isPanning = false;
            dragStart = null;
            previewPanel.style.cursor = 'grab';
            const svg = svgContainer.querySelector('svg');
            if (svg) {
                isShowingVector = true;
                updateViewMode();
            }
        }
    });
    previewPanel.addEventListener('mouseleave', () => {
        if (isPanning) {
            isPanning = false;
            dragStart = null;
            previewPanel.style.cursor = 'grab';
        }
    });

    // Tracing Logic
    traceBtn.addEventListener('click', () => {
        if (!originalImage.src) return;

        traceBtn.disabled = true;
        traceBtn.textContent = 'Tracing...';
        svgContainer.innerHTML = '';

        setTimeout(() => {
            const toleranceSettings = getToleranceSettings();
            const options = { ...toleranceSettings };
            
            settingsInputs.forEach(input => {
                if(input.id === 'line-fit-tolerance') return;

                if (input.type === 'checkbox') {
                    options[input.name] = input.checked;
                } else if (input.type === 'range' || input.type === 'number') {
                    options[input.name] = parseFloat(input.value);
                }
            });
            
            const handleSuccess = (svgString) => {
                if (!svgString || typeof svgString !== 'string' || svgString.trim().length === 0) {
                    svgContainer.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 120"><rect width="300" height="120" fill="#111"/><text x="14" y="45" fill="#fff" font-size="14">Empty SVG. Check parameters.</text></svg>';
                } else {
                    renderSVGString(svgString);
                }
                const svg = svgContainer.querySelector('svg');
                const hasValidSvg = !!svg && svg.children.length > 0;
                isShowingVector = hasValidSvg;
                
                updateTransform();
                updateViewMode();
                hasTraced = true;

                traceBtn.disabled = false;
                traceBtn.textContent = 'Retrace';
                saveSvgBtn.disabled = false;
                if (copyClipboardBtn) copyClipboardBtn.disabled = false;
                clearAllBtn.disabled = false;
            };

            const handleError = (err) => {
                console.error('Tracing error:', err);
                alert('Error during tracing. Try adjusting settings.');
                traceBtn.disabled = false;
                traceBtn.textContent = hasTraced ? 'Retrace' : 'Trace';
            };

            vtrace.trace(originalImage.src, options)
                .then(handleSuccess)
                .catch(handleError);

        }, 50);
    });

    // Zoom Logic
    previewPanel.addEventListener('wheel', (e) => {
        if (!originalImage.src) return;
        e.preventDefault();
        
        const zoomSpeed = 1.1;
        const delta = e.deltaY > 0 ? -1 : 1;
        
        if (delta > 0) {
            scale = Math.min(maxScale, scale * zoomSpeed);
        } else {
            scale = Math.max(minScale, scale / zoomSpeed);
        }
        
        updateTransform();
    });

    // --- INITIAL STATE ---
    setSettingIndicators();
    attachInfoIconTooltips();
    clearImage();
});
