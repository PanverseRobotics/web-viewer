import './lib/utils/linalg.js';
import './lib/pipeline.js';

import { mat3transpose, mat3multiply, mat4multiply, mat4perspective, mat4lookAt } from './lib/utils/linalg.js';
import { viewMoveMouse, viewDollyWheel } from './lib/utils/view.js';
import { rotorToRotationMatrix, rotorsToCov3D } from './lib/utils/rotors.js';
import { createPipeline, applyPipeline, createFullSortPipeline, applyFullSortPipeline, toTexture } from './lib/pipeline.js';
import { permuteArray } from './lib/pointarray.js';
import createRenderProgram from './lib/rendering/vpshaders.js';

let fpsData = {
    then: 0,
    frameTimes: [],
    frameCursor: 0,
    numFrames: 0,
    maxFrames: 20,
    totalFPS: 0
};

function initCanvas() {
    var canvas = document.getElementById("gl-canvas");
    //canvas.width = window.innerWidth;
    //canvas.height = window.innerHeight;

    return canvas;
}

function initWebgl(canvas) {
    var gl = canvas.getContext("webgl2");

    if (!gl) {
        console.error("WebGL 2 not available");
        document.body.innerHTML = "This example requires WebGL 2 which is unavailable on this system."
    }

    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    // gl.enable(gl.BLEND);
    // gl.depthMask(false);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (!gl.getExtension("EXT_color_buffer_float")) {
        console.error("FLOAT color buffer not available");
        document.body.innerHTML = "This example requires EXT_color_buffer_float which is unavailable on this system."
    }

    return gl;
}

function updateFPSDisplay(fps, averageFPS) {
    const fpsElem = document.querySelector("#fps");
    if (!fpsElem) return;
    fpsElem.textContent = fps.toFixed(1);  // update fps display
    const avgElem = document.querySelector("#avg");
    if (!avgElem) return;
    avgElem.textContent = averageFPS.toFixed(1);  // update avg display
}

function calcFPS(now) {
    const deltaTime = now - fpsData.then;
    fpsData.then = now;
    if (deltaTime == 0) return;

    const fps = 1000 / deltaTime;

    // add the current fps and remove the oldest fps
    fpsData.totalFPS += fps - (fpsData.frameTimes[fpsData.frameCursor] || 0);

    // record the newest fps
    fpsData.frameTimes[fpsData.frameCursor++] = fps;

    // needed so the first N frames, before we have maxFrames, is correct.
    fpsData.numFrames = Math.max(fpsData.numFrames, fpsData.frameCursor);

    // wrap the cursor
    fpsData.frameCursor %= fpsData.maxFrames;

    updateFPSDisplay(fps, fpsData.totalFPS / fpsData.numFrames);
}

function getCameraTransform(canvas, viewParams){
    var projMatrix = new Float32Array(16);
    var viewMatrix = new Float32Array(16);
    var viewProjMatrix = new Float32Array(16);

    mat4perspective(projMatrix, Math.PI / 3, canvas.width / canvas.height, 0.1, 20.0);
    mat4lookAt(viewMatrix, viewParams.eyePosition, viewParams.focusPosition, viewParams.up);
    mat4multiply(viewProjMatrix, projMatrix, viewMatrix);

    return {
        proj: projMatrix,
        view: viewMatrix,
        viewProj: viewProjMatrix
    }
}

function makeTextures(gl, position, color, covUpper, covDiag, group_size, n_groups) {
    return {
        position: toTexture(gl, position, group_size, n_groups, 'float', 3),
        color: toTexture(gl, color, group_size, n_groups, 'float', 4),
        covDiag: toTexture(gl, covDiag, group_size, n_groups, 'float', 3),
        covUpper: toTexture(gl, covUpper, group_size, n_groups, 'float', 3)
    }
}

function setTextures(gl, program, permTextures, vertexTextures, pipelineType) {
    if (pipelineType == 'full') {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, permTextures.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        const permIdxLoc = gl.getUniformLocation(program, 'perm_idx');
        gl.uniform1i(permIdxLoc, 0);
    } else {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, permTextures.outer.texture);
        gl.uniform1i(gl.getUniformLocation(program, 'perm_outer_idx'), 2);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, permTextures.inner.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        const permInnerIdxLoc = gl.getUniformLocation(program, 'perm_inner_idx');
        gl.uniform1i(permInnerIdxLoc, 0);
    }

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, vertexTextures.position.texture);
    gl.uniform1i(gl.getUniformLocation(program, 'positionTexture'), 3);

    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, vertexTextures.color.texture);
    gl.uniform1i(gl.getUniformLocation(program, 'colorTexture'), 4);

    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, vertexTextures.covDiag.texture);
    gl.uniform1i(gl.getUniformLocation(program, 'covDiagTexture'), 5);

    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, vertexTextures.covUpper.texture);
    gl.uniform1i(gl.getUniformLocation(program, 'covUpperTexture'), 6);
}

// pipelineType can be 'full' or 'groups'
function renderMain(data, pipelineType='full') {
    let canvas = initCanvas();
    let gl = initWebgl(canvas);

    let shaderProgram = createRenderProgram(gl, pipelineType);


    // Create objects
    const GROUP_SIZE = 1024; //gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const N_GROUPS = Math.floor(Math.floor(data.positions.length / 3) / GROUP_SIZE);
    const NUM_PARTICLES = GROUP_SIZE * N_GROUPS;
    // const NUM_PARTICLES = 2048000; // for testing only

    const SORT_INTERVAL = 1;

    let positionData = data.positions;
    let colorData = data.colors;

    let covData = rotorsToCov3D(data.scales, data.rotors);
    let covDiagData = covData.diag;
    let covUpperData = covData.upper;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    gl.useProgram(shaderProgram);

    var buffer = gl.createBuffer();
    // make this buffer the current 'ELEMENT_ARRAY_BUFFER'
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer);
    gl.bufferData(
        gl.ELEMENT_ARRAY_BUFFER,
        new Uint32Array(32),
        gl.STATIC_DRAW
    );

    let pipeline;
    if (pipelineType == 'full') {
        pipeline = createFullSortPipeline(gl, positionData, GROUP_SIZE, N_GROUPS);
    } else {
        pipeline = createPipeline(gl, positionData, GROUP_SIZE, N_GROUPS);

        positionData = permuteArray(positionData, pipeline.perm, 3);
        colorData = permuteArray(colorData, pipeline.perm, 4);
        covDiagData = permuteArray(covDiagData, pipeline.perm, 3);
        covUpperData = permuteArray(covUpperData, pipeline.perm, 3);
    }

    let vertexTextures = makeTextures(gl, positionData, colorData, covUpperData, covDiagData, GROUP_SIZE, N_GROUPS);
    var animationFrameId;

    var i = 0;
    let isMouseDown = false;
    let lastMousePosition = [0, 0];

    var viewParams = {
        up: [0, -1, 0],
        eyePosition: [5, 0, 0],
        focusPosition: [0, 0, 0],
        azimuth: 0.0,
        elevation: 0.0,
        radius: 5.0,
        lookSensitivity: 100.0
    };

    let draw = function (now) {
        // Check if the canvas still exists
        if (!document.body.contains(gl.canvas)) {
            cancelAnimationFrame(animationFrameId);
            return;
        }

        // Set scene transforms.
        let cameraXform = getCameraTransform(canvas, viewParams);

        // apply sorting pipeline.
        let permTextures;
        if (i % SORT_INTERVAL == 0) {
            if (pipelineType == 'full') {
                permTextures = applyFullSortPipeline(gl, pipeline, cameraXform.viewProj);
            } else {
                permTextures = applyPipeline(gl, pipeline, viewParams.eyePosition, cameraXform.viewProj);
            }
        }

        // Set scene transform uniforms.
        gl.useProgram(shaderProgram);
        gl.uniformMatrix4fv(gl.getUniformLocation(shaderProgram, 'uView'), false, cameraXform.view);
        gl.uniformMatrix4fv(gl.getUniformLocation(shaderProgram, 'uViewProj'), false, cameraXform.viewProj);

        let viewportScale = new Float32Array([canvas.width, canvas.height]);
        //let viewportScale = new Float32Array([512,512]);

        gl.uniform3fv(gl.getUniformLocation(shaderProgram, 'uEyePosition'), viewParams.eyePosition);
        gl.uniform2fv(gl.getUniformLocation(shaderProgram, 'uViewportScale'), viewportScale);

        // Set viewport params.
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(0, 0, canvas.width, canvas.height);

        setTextures(gl, shaderProgram, permTextures, vertexTextures, pipelineType);
        gl.uniform2i(gl.getUniformLocation(shaderProgram, 'textureSize'), GROUP_SIZE, N_GROUPS);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        // Prepare viewport for rendering and blending.
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE);                //gl.drawArrays(gl.POINTS, 0, NUM_PARTICLES);

        // Draw all the vertices as points, in the order given in the element array buffer.
        gl.drawArrays(gl.POINTS, 0, NUM_PARTICLES);

        // Reset values of variables so that other shaders can run.
        gl.enable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);

        calcFPS(now);

        // Request next animation frame
        animationFrameId = requestAnimationFrame(draw);
    }

    // Function to resize the canvas to full window size
    function resizeCanvas() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }


    function handleVisibilityChange() {
        if (document.hidden) {
            cancelAnimationFrame(animationFrameId);
        } else {
            animationFrameId = requestAnimationFrame(draw);
        }
    }

    // Listen for window resize events
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas(); // Initial resize

    // Event listener for tab visibility
    document.addEventListener("visibilitychange", handleVisibilityChange, false);

    // Start the animation loop
    animationFrameId = requestAnimationFrame(draw);
        
    // Prevent default right-click context menu on the canvas
    canvas.addEventListener('contextmenu', function(e) {
        e.preventDefault(); // Prevents the default context menu from appearing
    });

    canvas.addEventListener('mousedown', function (event) {
        isMouseDown = true;
        lastMousePosition = [event.clientX, event.clientY];
    });

    canvas.addEventListener('mousemove', function (event) {
        viewMoveMouse(event, lastMousePosition, viewParams);
        lastMousePosition = [event.clientX, event.clientY];
    });

    canvas.addEventListener('mouseup', function (event) {
        isMouseDown = false;
    });

    
    canvas.addEventListener('wheel', function (event) {
        event.preventDefault(); // Prevents the default scrolling behavior
        
        viewDollyWheel(event, viewParams);

    },{ passive: false });

    canvas.addEventListener('mouseleave', function (event) {
        isMouseDown = false;
    });
    
    return draw;
}


export { renderMain };

