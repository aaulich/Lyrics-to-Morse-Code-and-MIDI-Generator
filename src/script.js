const morseAlphabet = {
    'A': '.-', 'B': '-...', 'C': '-.-.', 'D': '-..', 'E': '.', 'F': '..-.',
    'G': '--.', 'H': '....', 'I': '..', 'J': '.---', 'K': '-.-', 'L': '.-..',
    'M': '--', 'N': '-.', 'O': '---', 'P': '.--.', 'Q': '--.-', 'R': '.-.',
    'S': '...', 'T': '-', 'U': '..-', 'V': '...-', 'W': '.--', 'X': '-..-',
    'Y': '-.--', 'Z': '--..', '1': '.----', '2': '..---', '3': '...--',
    '4': '....-', '5': '.....', '6': '-....', '7': '--...', '8': '---..',
    '9': '----.', '0': '-----',
    'Ä': '.-.-', 'Ö': '---.', 'Ü': '..--', 'CH': '----', 'ẞ': '...--..',
    'É': '..-..', 'À': '.--.-', 'Å': '.--.-', 'Ç': '-.-..', 'Ñ': '--.--',
    '.': '.-.-.-', ',': '--..--', '?': '..--..', "'": '.----.', '!': '-.-.--',
    '/': '-..-.', '(': '-.--.', ')': '-.--.-', '&': '.-...', ':': '---...',
    ';': '-.-.-.', '=': '-...-', '+': '.-.-.', '-': '-....-', '_': '..--.-',
    '"': '.-..-.', '$': '...-..-', '@': '.--.-.',
    ' ': '/'
};

const lyricsInput = document.getElementById('lyrics-input');
const morseOutput = document.getElementById('morse-output');
const staffOutput = document.getElementById('staff-output');
const downloadMidiBtn = document.getElementById('download-midi');
const downloadPdfBtn = document.getElementById('download-pdf');
const rhythmSelect = document.getElementById('rhythm-select');
const playAudioBtn = document.getElementById('play-audio');
const playIcon = document.getElementById('play-icon');

let audioContext = null;
let isPlaying = false;
let playbackTimeout = null;
let visualTimeouts = [];
let activeOscillators = [];
let currentNoteIndex = -1;
let noteElements = [];
let noteTimings = [];

function textToMorse(text) {
    const upperText = text.toUpperCase();
    let mappings = [];
    for (let i = 0; i < upperText.length; i++) {
        let char = upperText[i];
        let morse = '';
        // Check for 'CH' digraph
        if (upperText[i] === 'C' && upperText[i + 1] === 'H') {
            char = 'CH';
            morse = morseAlphabet['CH'];
            i++; // Skip 'H'
        } else {
            morse = morseAlphabet[char] || char;
        }
        mappings.push({ char: char, morse: morse });
    }
    return mappings;
}

function getDurationInBeats(char, rhythm) {
    // 8th note = 0.5 beats, 4th note = 1 beat
    if (char === '.') return 0.5;
    if (char === '-') return 1;
    if (char === '/' || char === ' ') return 0.5;
    return 0;
}

function updateStaff(mappings) {
    console.log("updateStaff called", mappings);
    staffOutput.innerHTML = '';
    noteElements = [];
    noteTimings = [];
    
    if (!mappings || mappings.length === 0) {
        console.log("No mappings to display");
        return;
    }

    if (typeof Vex === 'undefined') {
        staffOutput.innerHTML = '<p class="text-red-500 text-sm">Error: Musical notation library (VexFlow) not loaded. Please check your internet connection.</p>';
        console.error("VexFlow is not defined.");
        return;
    }

    // Try to find the Flow namespace first to avoid issues with Vex root object
    let Flow = Vex.Flow || Vex.flow;
    
    // In some builds, Vex is the namespace itself
    if (!Flow && Vex.Renderer) {
        Flow = Vex;
    }

    if (!Flow) {
        staffOutput.innerHTML = '<p class="text-red-500 text-sm">Error: VexFlow library structure unexpected.</p>';
        console.error("Flow namespace not found in Vex object:", Vex);
        return;
    }

    console.log("Vex object detected");
    console.log("Flow namespace detected");
    
    // Check if VexFlow version is old
    let vexVersion = 'unknown';
    try {
        if (Vex.Flow.BUILD && Vex.Flow.BUILD.VERSION) {
            vexVersion = Vex.Flow.BUILD.VERSION;
        } else if (Vex.Flow.VERSION) {
            vexVersion = Vex.Flow.VERSION;
        } else if (Vex.VERSION) {
            vexVersion = Vex.VERSION;
        }
    } catch (e) {
        console.warn("Could not determine VexFlow version", e);
    }
    console.log("Detected VexFlow version:", vexVersion);
    
    const isOldVex = vexVersion.startsWith('3.');
    const isVex5 = vexVersion.startsWith('5.');
    const isVex4 = vexVersion.startsWith('4.');
    
    const timeSignature = rhythmSelect.value; // "4/4" or "3/4"
    const [numBeats, beatValue] = timeSignature.split('/').map(Number);
    const beatsPerBar = numBeats;
    const unitsPerBar = beatsPerBar * 2; // 1 unit = 0.5 beats (8th note)

    const { Renderer, Stave, StaveNote, Voice, Formatter, Beam, Annotation, StaveTie } = Flow;

    // Limit mappings for performance
    const maxChars = 200; // Increased to allow more lyrics on multiple pages
    const displayMappings = mappings.slice(0, maxChars);

    // 1. Generate flat sequence of musical events
    const sequence = [];
    displayMappings.forEach((mapping, mapIdx) => {
        const morseChars = mapping.morse.split('');
        morseChars.forEach((mChar, index) => {
            if (mChar === '.') {
                sequence.push({ type: 'note', duration: 1, mChar: '.', lyric: (index === 0 && mapping.char !== ' ' && mapping.char !== '/') ? mapping.char : null });
            } else if (mChar === '-') {
                sequence.push({ type: 'note', duration: 2, mChar: '-', lyric: (index === 0 && mapping.char !== ' ' && mapping.char !== '/') ? mapping.char : null });
            } else if (mChar === '/' || mChar === ' ') {
                sequence.push({ type: 'rest', duration: 1, mChar: ' ', lyric: null });
            }
        });
        // Inter-character gap (only add if not the last character)
        const isLastChar = mapIdx === displayMappings.length - 1;
        if (mapping.char !== ' ' && mapping.char !== '/' && !isLastChar) {
            sequence.push({ type: 'rest', duration: 1, mChar: ' ', lyric: null, isGap: true });
        }
    });

    // 2. Group into bars with splitting
    const barData = [];
    let currentBar = [];
    let currentUnits = 0;

    sequence.forEach(event => {
        let remaining = event.duration;
        let isFirstPart = true;

        while (remaining > 0) {
            let available = unitsPerBar - currentUnits;

            // If the current bar is full, push it and start a new one
            if (available === 0) {
                barData.push(currentBar);
                currentBar = [];
                currentUnits = 0;
                available = unitsPerBar;
            }

            let take = Math.min(remaining, available);

            // Check if we need to split a note
            if (take < remaining && event.type === 'note') {
                // We're splitting a note across bars
                const notePart = {
                    ...event,
                    duration: take,
                    lyric: isFirstPart ? event.lyric : null,
                    isSplit: true,
                    splitPart: isFirstPart ? 'first' : 'middle',
                    tieNext: true
                };

                currentBar.push(notePart);
                remaining -= take;
                currentUnits += take;
                isFirstPart = false;
            } else {
                // Event fits completely in current bar, or it's the last part of a split
                const notePart = {
                    ...event,
                    duration: take,
                    lyric: isFirstPart ? event.lyric : null
                };

                if (!isFirstPart && event.type === 'note') {
                    notePart.isSplit = true;
                    notePart.splitPart = 'last';
                }

                currentBar.push(notePart);
                remaining -= take;
                currentUnits += take;
            }
        }
    });

    // Final padding
    if (currentUnits > 0 || barData.length === 0) {
        while (currentUnits < unitsPerBar) {
            let pad = Math.min(2, unitsPerBar - currentUnits);
            currentBar.push({ type: 'rest', duration: pad, isPadding: true });
            currentUnits += pad;
        }
        barData.push(currentBar);
    }

    // 3. Convert barData to VexFlow bars and calculate timings
    const bars = [];
    const ties = [];
    noteTimings = [];
    let currentTime = 0;
    const bpm = 120;
    const secondsPerBeat = 60 / bpm;
    let lastTieNote = null;

    barData.forEach((barNotesData, barIndex) => {
        const barNotes = [];
        barNotesData.forEach((data, noteIndex) => {
            let note = null;
            let durationStr = data.duration === 1 ? '8' : '4';
            if (data.type === 'rest') durationStr += 'r';

            note = new StaveNote({
                keys: ['b/4'],
                duration: durationStr,
                stem_direction: 1
            });

            if (data.lyric) {
                addLyricToNote(note, data.lyric, Annotation, Flow);
            }

            barNotes.push(note);

            // Handle ties for split notes
            if (data.isSplit && data.splitPart !== 'first') {
                if (lastTieNote) {
                    ties.push({ first: lastTieNote, last: note });
                }
                lastTieNote = null;
            } else {
                // Not a continuation part (could be a rest, a non-split note, or a 'first' part)
                // Clear any pending tie from a previous bar that didn't find its continuation
                lastTieNote = null;
            }

            if (data.tieNext) {
                lastTieNote = note;
            }

            // Timing
            noteTimings.push({
                time: currentTime,
                duration: data.duration * 0.5 * secondsPerBeat,
                isRest: data.type === 'rest',
                type: data.mChar || (data.isPadding ? 'padding' : ' ')
            });
            currentTime += data.duration * 0.5 * secondsPerBeat;
        });
        bars.push(barNotes);
    });

    // Helper function to add lyric
    function addLyricToNote(note, text, Annotation, Flow) {
        try {
            const annotation = new Annotation(text);
            const VerticalJustification = Annotation.VerticalJustification || Flow.Annotation.VerticalJustification || { BOTTOM: 3 };
            if (typeof annotation.setVerticalJustification === 'function') {
                annotation.setVerticalJustification(VerticalJustification.BOTTOM);
            }
            if (typeof annotation.setFont === 'function') {
                try {
                    annotation.setFont({ family: 'Arial', size: 14, weight: 'bold' });
                } catch (e1) {
                    try {
                        annotation.setFont('Arial', 14, 'bold');
                    } catch (e2) {}
                }
            }
            if (typeof note.addModifier === 'function') {
                note.addModifier(annotation, 0);
            }
        } catch (e) {
            console.error("Error creating or adding annotation:", e.message);
        }
    }

    const staveWidth = 300;
    const containerWidth = Math.max(800, document.getElementById('staff-container').offsetWidth - 40); // fallback to 800 if 0
    console.log("Container width:", containerWidth);
    const stavesPerRow = Math.max(1, Math.floor(containerWidth / staveWidth));
    const numRows = Math.ceil(bars.length / stavesPerRow);
    
    const rendererWidth = containerWidth;
    const rowHeight = 180; // Increased height to ensure lyrics fit and spacing is consistent
    
    try {
        const backend = (isVex5 || isVex4) ? Renderer.Backends.SVG : (Renderer.Backends.SVG || 1);
        
        console.log("Rendering bars:", bars.length);
        
        let currentRowDiv = null;
        let currentContext = null;
        const contexts = [];

        bars.forEach((barNotes, index) => {
            try {
                const col = index % stavesPerRow;
                
                if (col === 0) {
                    // Create a new row container
                    currentRowDiv = document.createElement('div');
                    currentRowDiv.className = 'staff-row';
                    currentRowDiv.style.width = '100%';
                    currentRowDiv.style.height = `${rowHeight}px`;
                    currentRowDiv.style.pageBreakInside = 'avoid';
                    currentRowDiv.style.breakInside = 'avoid';
                    currentRowDiv.style.overflow = 'hidden'; // Ensure no bleeding between rows
                    staffOutput.appendChild(currentRowDiv);
                    
                    const renderer = new Renderer(currentRowDiv, backend);
                    renderer.resize(rendererWidth, rowHeight);
                    currentContext = renderer.getContext();
                    contexts.push(currentContext);
                }
                
                const x = col * staveWidth + 10;
                const y = 20; // Reset Y for each row since each row has its own SVG

                const stave = new Stave(x, y, staveWidth);
                stave.setContext(currentContext);
                
                // Add extra space for lyrics below the stave
                stave.setMeasure(index + 1);
                stave.setEndBarType(Flow.Barline.type.SINGLE);
                if (index === 0) {
                    stave.addClef('treble').addTimeSignature(timeSignature);
                } else if (col === 0) {
                    stave.addClef('treble');
                }
                stave.setContext(currentContext).draw();

                const voice = new Voice({
                    num_beats: beatsPerBar,
                    beat_value: beatValue
                }).setMode(Voice.Mode.SOFT);

                voice.addTickables(barNotes);

                // Use formatter to justify notes within the bar
                new Formatter().joinVoices([voice]).format([voice], staveWidth - 80);

                voice.draw(currentContext, stave);
                
            } catch (e) {
                console.error("Error drawing bar " + index, e);
                staffOutput.innerHTML += `<div class="text-red-500 text-xs border p-1 mb-1">Error drawing bar ${index + 1}: ${e.message}</div>`;
            }
        });

        // Draw ties
        ties.forEach(t => {
            const firstNoteIndex = bars.findIndex(bar => bar.includes(t.first));
            const lastNoteIndex = bars.findIndex(bar => bar.includes(t.last));
            
            if (firstNoteIndex !== -1 && lastNoteIndex !== -1) {
                const firstRow = Math.floor(firstNoteIndex / stavesPerRow);
                const lastRow = Math.floor(lastNoteIndex / stavesPerRow);
                
                // VexFlow StaveTie across different contexts is not natively supported to draw correctly across SVGs.
                // If it's the same row, it works fine.
                if (firstRow === lastRow) {
                    new StaveTie({
                        first_note: t.first,
                        last_note: t.last,
                        first_indices: [0],
                        last_indices: [0],
                    }).setContext(contexts[firstRow]).draw();
                } else {
                    // Tie across rows: draw half-ties in both rows
                    // Part 1: Draw from the first note to the end of its row
                    new StaveTie({
                        first_note: t.first,
                        first_indices: [0],
                    }).setContext(contexts[firstRow]).draw();
                    
                    // Part 2: Draw from the beginning of the next row to the last note
                    new StaveTie({
                        last_note: t.last,
                        last_indices: [0],
                    }).setContext(contexts[lastRow]).draw();
                }
            }
        });
    } catch (e) {
        console.error("Renderer initialization failed:", e);
        staffOutput.innerHTML = `<p class="text-red-500 text-sm">Error initializing musical renderer: ${e.message}</p>`;
        return;
    }

    // Re-collect elements across all row containers
    noteElements = Array.from(staffOutput.querySelectorAll('.vf-stavenote'));
}

function playNote(freq, startTime, duration) {
    if (!audioContext) return;

    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, startTime);

    const attackTime = 0.01;
    const releaseTime = 0.01;
    const actualDuration = Math.max(duration, attackTime + releaseTime + 0.01);

    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(0.2, startTime + attackTime);
    gain.gain.setValueAtTime(0.2, startTime + actualDuration - releaseTime);
    gain.gain.linearRampToValueAtTime(0, startTime + actualDuration);

    osc.connect(gain);
    gain.connect(audioContext.destination);

    osc.start(startTime);
    osc.stop(startTime + actualDuration);
    
    activeOscillators.push(osc);
    osc.onended = () => {
        activeOscillators = activeOscillators.filter(o => o !== osc);
    };
}

function stopPlayback() {
    isPlaying = false;
    playIcon.textContent = '▶';
    playAudioBtn.classList.remove('bg-red-600', 'hover:bg-red-700');
    playAudioBtn.classList.add('bg-green-600', 'hover:bg-green-700');
    
    if (playbackTimeout) {
        clearTimeout(playbackTimeout);
        playbackTimeout = null;
    }
    
    visualTimeouts.forEach(t => clearTimeout(t));
    visualTimeouts = [];
    
    activeOscillators.forEach(osc => {
        try {
            osc.stop();
        } catch (e) {
            // Oscillator might have already stopped
        }
    });
    activeOscillators = [];
    
    // Clear highlights
    noteElements.forEach(el => {
        if (el) {
            el.classList.remove('fill-red-500', 'text-red-500', 'highlight-note');
            el.querySelectorAll('path').forEach(p => p.style.fill = '');
        }
    });
    currentNoteIndex = -1;
}

function startPlayback() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }

    isPlaying = true;
    playIcon.textContent = '⏹';
    playAudioBtn.classList.remove('bg-green-600', 'hover:bg-green-700');
    playAudioBtn.classList.add('bg-red-600', 'hover:bg-red-700');

    const startTime = audioContext.currentTime + 0.1;
    
    noteTimings.forEach((timing, index) => {
        if (!timing.isRest) {
            playNote(440, startTime + timing.time, timing.duration);
        }
        
        // Schedule visual highlight
        const vTimeout = setTimeout(() => {
            if (!isPlaying) return;
            
            // Remove previous highlight
            if (currentNoteIndex >= 0 && noteElements[currentNoteIndex]) {
                noteElements[currentNoteIndex].classList.remove('highlight-note');
                // VexFlow SVG elements use fill attribute
                noteElements[currentNoteIndex].querySelectorAll('path').forEach(p => p.style.fill = '');
            }
            
            currentNoteIndex = index;
            
            // Add new highlight
            if (noteElements[currentNoteIndex]) {
                noteElements[currentNoteIndex].querySelectorAll('path').forEach(p => p.style.fill = '#ef4444');
            }
        }, (timing.time + 0.1) * 1000);
        visualTimeouts.push(vTimeout);
    });

    const totalDuration = noteTimings.length > 0 ? 
        (noteTimings[noteTimings.length - 1].time + noteTimings[noteTimings.length - 1].duration) : 0;

    playbackTimeout = setTimeout(() => {
        stopPlayback();
    }, (totalDuration + 0.2) * 1000);
}

function generateMIDI(text) {
    const mappings = textToMorse(text);
    const track = new MidiWriter.Track();
    track.setTempo(120);

    mappings.forEach(mapping => {
        const morseChars = mapping.morse.split('');
        morseChars.forEach(mChar => {
            if (mChar === '.') {
                track.addEvent(new MidiWriter.NoteEvent({ pitch: ['B4'], duration: '8' }));
            } else if (mChar === '-') {
                track.addEvent(new MidiWriter.NoteEvent({ pitch: ['B4'], duration: '4' }));
            } else if (mChar === '/' || mChar === ' ') {
                track.addEvent(new MidiWriter.NoteEvent({ pitch: ['B4'], duration: '0', wait: '8' }));
            }
        });
        // Add inter-character gap
        if (mapping.char !== ' ' && mapping.char !== '/') {
            track.addEvent(new MidiWriter.NoteEvent({ pitch: ['B4'], duration: '0', wait: '8' }));
        }
    });

    // Note: The visual staff and audio playback now pad bars with rests.
    // MIDI generation currently follows the Morse sequence directly without bar padding.
    // This is generally preferred for MIDI files unless a specific rhythm/meter is required.

    const write = new MidiWriter.Writer(track);
    return write.dataUri();
}

downloadPdfBtn.addEventListener('click', () => {
    // 1. Update UI immediately
    const originalText = downloadPdfBtn.textContent;
    downloadPdfBtn.disabled = true;
    downloadPdfBtn.textContent = 'Generating PDF...';
    downloadPdfBtn.classList.add('opacity-75', 'cursor-not-allowed');

    // 2. Wrap heavy work in setTimeout to allow UI to repaint
    setTimeout(() => {
        const originalElement = document.querySelector('.staff-block');
        
        // Create a clone to modify for PDF output
        const element = originalElement.cloneNode(true);
        
        // We want to hide the buttons and header in the PDF
        const header = element.querySelector('.section-header');
        if (header) header.remove();

        // Set options for html2pdf
        const opt = {
            margin:       10,
            filename:     'musical-staff.pdf',
            image:        { type: 'jpeg', quality: 0.98 },
            html2canvas:  { 
                scale: 2, 
                useCORS: true, 
                logging: false,
                letterRendering: true,
                scrollX: 0,
                scrollY: 0
            },
            jsPDF:        { unit: 'mm', format: 'a4', orientation: 'portrait', compress: true },
            pagebreak:    { mode: ['css', 'legacy'] }
        };

        // Ensure the cloned element has a width that fits in A4
        const pdfContentWidth = 718; 
        element.style.width = pdfContentWidth + 'px';
        element.style.padding = '10px';
        element.style.backgroundColor = 'white';
        element.style.border = 'none';
        element.style.boxShadow = 'none';
        element.style.margin = '0 auto';
        element.style.overflow = 'visible';
        
        // Find the staff-output in the clone and adjust it
        const clonedStaffOutput = element.querySelector('#staff-output');
        if (clonedStaffOutput) {
            clonedStaffOutput.style.width = '100%';
            clonedStaffOutput.style.display = 'flex';
            clonedStaffOutput.style.flexDirection = 'column';
            clonedStaffOutput.style.gap = '20px';
            clonedStaffOutput.style.margin = '0';
            clonedStaffOutput.style.padding = '0';
        }

        // Adjust row containers in the PDF clone
        const rows = element.querySelectorAll('.staff-row');
        rows.forEach((row) => {
            row.style.pageBreakInside = 'avoid';
            row.style.breakInside = 'avoid';
            row.style.display = 'block';
            row.style.position = 'relative';
            row.style.height = '180px';
            row.style.marginBottom = '20px';
            row.style.width = '100%';
            row.style.overflow = 'visible';
            
            const svg = row.querySelector('svg');
            if (svg) {
                svg.style.maxWidth = '100%';
                svg.style.height = 'auto';
            }
        });

        // Use html2pdf to generate and download the PDF
        const worker = html2pdf().set(opt).from(element);
        worker.save().then(() => {
            // Restore button state
            downloadPdfBtn.disabled = false;
            downloadPdfBtn.textContent = originalText;
            downloadPdfBtn.classList.remove('opacity-75', 'cursor-not-allowed');
        }).catch(err => {
            console.error('PDF generation error:', err);
            downloadPdfBtn.disabled = false;
            downloadPdfBtn.textContent = originalText;
            downloadPdfBtn.classList.remove('opacity-75', 'cursor-not-allowed');
            
            if (err.message && err.message.includes('oklch')) {
                alert('PDF generation failed due to an unsupported color format in the CSS.');
            } else {
                alert('PDF generation failed: ' + err.message);
            }
        });
    }, 10);
});

downloadMidiBtn.addEventListener('click', () => {
    const text = lyricsInput.value;
    if (!text.trim()) return;

    // 1. Update UI immediately
    const originalText = downloadMidiBtn.textContent;
    downloadMidiBtn.disabled = true;
    downloadMidiBtn.textContent = 'Generating MIDI...';
    downloadMidiBtn.classList.add('opacity-75', 'cursor-not-allowed');

    // 2. Wrap heavy work in setTimeout to allow UI to repaint
    setTimeout(() => {
        try {
            const midiUri = generateMIDI(text);
            const link = document.createElement('a');
            link.href = midiUri;
            link.download = 'lyrics-morse.mid';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        } catch (err) {
            console.error('MIDI generation error:', err);
            alert('MIDI generation failed: ' + err.message);
        } finally {
            // 3. Restore button state
            downloadMidiBtn.disabled = false;
            downloadMidiBtn.textContent = originalText;
            downloadMidiBtn.classList.remove('opacity-75', 'cursor-not-allowed');
        }
    }, 10);
});

playAudioBtn.addEventListener('click', () => {
    if (isPlaying) {
        stopPlayback();
    } else {
        if (noteTimings.length > 0) {
            startPlayback();
        }
    }
});

rhythmSelect.addEventListener('change', () => {
    const text = lyricsInput.value;
    if (text.trim()) {
        const mappings = textToMorse(text);
        updateStaff(mappings);
    }
});

lyricsInput.addEventListener('input', (e) => {
    const text = e.target.value;
    const mappings = textToMorse(text);
    morseOutput.textContent = mappings.map(m => m.morse).join(' ');
    updateStaff(mappings);
});

window.addEventListener('resize', () => {
    const text = lyricsInput.value;
    if (text.trim()) {
        const mappings = textToMorse(text);
        updateStaff(mappings);
    }
});

// Initialize if there's already text
if (lyricsInput.value.trim()) {
    const mappings = textToMorse(lyricsInput.value);
    morseOutput.textContent = mappings.map(m => m.morse).join(' ');
    updateStaff(mappings);
}
