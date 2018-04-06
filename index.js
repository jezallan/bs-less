/*eslint indent:[1,4]*/
module.exports = function (serverPath, opts) {
    'use strict';

    var path         = require('path'),
        fs           = require('fs'),
        url          = require('url'),
        stream       = require('stream'),
        bs           = require('browser-sync').create(),
        less         = require('less'),
        autoprefixer = require('autoprefixer')({
            browsers: ['last 2 versions', 'safari >= 8', 'ie >= 11']
        }),
        flexfix      = require('postcss-flexbugs-fixes'),
        postcss      = require('postcss'),
        browserify   = require('browserify'),
        babel        = require('babel-core'),
        babelify     = require('babelify'),
        babelEnv     = require('babel-preset-env'),
        babelStage3  = require('babel-preset-stage-3'),
        marked       = require('marked').setOptions({smartypants: true}),
        CACHE        = {},
        watcherOpts  = {
            ignoreinitial: false,
            ignored: [
                'node_modules', 
                'build', 
                'scripts', 
                'src', 
                'app.js',
                'app.bundle.js',
                'vendor.js', 
                'vendor.bundle.js', 
                'webpack.config.js'
            ]
        };

    function resolveFilePath(fileName, parentName) {
        var dir = path.dirname(parentName);
        if (fileName.match(/^\/\w/)) { dir = serverPath; }
        fileName = path.join(dir, fileName);
        if (!path.extname(fileName)) { return path.join(fileName, 'index.html'); }
        return fileName;
    }
    function replaceMatch(match, newContent, groupIndex) {
        const raw = match[0],
            content = match[groupIndex || 0],
            input = match.input,
            index = match.index,
            pre = input.substring(0, index),
            pos = input.substring(index + raw.length);

        //replace through fn to avoid $n substitution
        return pre + raw.replace(content, () => newContent) + pos;
    }
    function adjustFilePaths(vFile) {
        var links = /<[\w-]+ +.*?(?:src|href)=['"]?(.+?)['">\s]/g;
        return new Promise(function (resolve) {
            vFile.source = vFile.source.replace(links, function (m, src) {
                src = src.trim();
                if (!src || src.match(/^(\w+:|#|{|\/|\$)/)) { return m; }
                var resolved = resolveFilePath(src, vFile.path);
                return m.replace(src, resolved);
            });
            resolve(vFile);
        });
    }
    function readFile(filePath) {
        return new Promise(function (resolve, reject) {
            function onFile(err, contents) {
                if (err) { return reject(err.message); }
                if (path.extname(filePath).match(/\.(md|markdown|mdown)/)) {
                    contents = marked(contents.toString());
                }
                const vFile = { path: filePath, source: contents.toString() },
                    cachedFile = CACHE[filePath];
                //RETRIEVE PARENT FROM CACHE
                if (cachedFile && cachedFile.parentPath) {
                    vFile.parentPath = cachedFile.parentPath;
                }
                resolve(vFile);
            }
            fs.readFile(filePath, onFile);
        });
    }
    function getElementType(attrs) {
        attrs = attrs || '';
        const match = attrs.match(/\btype=["']?\w+\/(\w+)\b["']?/);
        return match && match[1];
    }

    function outputStyleError(msg, filePath) {
        return ''
            + 'html:before, :host:before {'
            + '  content: "STYLE ERROR: ' + msg + ' (' + filePath + ')";'
            + '  position: fixed;'
            + '  font: 1em/1.5 sans-serif;'
            + '  top: 0;'
            + '  left: 0;'
            + '  right: 0;'
            + '  padding: 1em;'
            + '  text-align: left;'
            + '  white-space: pre;'
            + '  color: white;'
            + '  background-color: tomato;'
            + '  z-index: 10000'
            + '}';
    }
    function outputJSError(msg) {
        var error = msg
            .replace(/"/g, '\\"')
            .replace(/\n/g, '\\n');
        return 'console.error("' + error  + '");';
    }

    function replaceEnvVars(vFile) {
        var pattern     = /(?:\$ENV|process\.env)\[['"]?([\w\.\-\/@]+?)['"]?\]/g,
            nodePattern = /process.env(?:\.(.+?)\b|\[(["'])(.+?)\2\])/g;
        return new Promise(function (resolve) {
            vFile.source = vFile.source.replace(pattern, function (_, v) {
                return process.env[v] || '';
            }).replace(nodePattern, function (m,v1,_,v3) {
                return `'${process.env[v1 || v3] || ''}'`;
            });
            resolve(vFile);
        });
    }
    function replaceSSI(vFile) {
        // more http://www.w3.org/Jigsaw/Doc/User/SSI.html#include
        var pattern = /<!--#include file=[\"\']?(.+?)[\"\']? -->/g;
        return new Promise(function (resolve) {
            function check (match) {
                if (!match) { return resolve(vFile); }
                readFile(resolveFilePath(match[1], vFile.path))
                    .then(adjustFilePaths)
                    .then(processHTML)
                    //.then(processInlineScripts)
                    //.then(replaceSSI)
                    //.then(replaceEnvVars)
                    .then(function ($vFile) {
                        vFile.source = replaceMatch(match, $vFile.source);
                        check(pattern.exec(vFile.source));

                        // UPDATE CACHED VERSION POINTING PARENT FILE
                        $vFile.parentPath = vFile.path;
                        CACHE[$vFile.path] = $vFile;

                        return vFile;
                    })
                    .catch(function (e) {
                        vFile.source = vFile.source
                        .replace(match[0], function () { return e; });
                        check(pattern.exec(vFile.source));
                    });
            }
            check(pattern.exec(vFile.source));
        });
    }

    function autoprefixCSS(vFile) {
        return new Promise((resolve, reject) => {
            try {
                const post = postcss([flexfix, autoprefixer])
                    .process(vFile.source, {
                        from: path.basename(vFile.path),
                        map: true
                    });
                if (post.warnings) {
                    post.warnings().forEach(function (warn) {
                        console.warn('POSTCSS', warn.toString());
                    });
                }
                vFile.source = post.css;
                resolve(vFile);
            } catch (e) {
                vFile.source = e.message;
                vFile.error = true;
                reject(vFile);
            }
        });
    }
    function lessify(vFile) {
        return new Promise((resolve, reject) => {
            less.render(vFile.source, {
                filename: vFile.path,
                relativeUrls: true,
                sourceMap: {
                    outputSourceFiles: true,
                    sourceMapBasepath: serverPath,
                    sourceMapFileInline: true
                }
            }).then((out) => {
                vFile.source = out.css;
                resolve(vFile);
            }).catch((e) => {
                vFile.error = true;
                vFile.source = e.message;
                reject(vFile);
            });
        });
    }
    function processStyle(vFile) {
        var ext = path.extname(vFile.path),
            promise = new Promise((r) => r(vFile));
        if (ext === '.less') { promise = lessify(vFile); }
        return promise
            .then(autoprefixCSS)
            .then((metaFile) => {
                metaFile.mimeType = 'text/css';
                return metaFile;
            })
            .catch(function (errorFile) {
                errorFile.source = JSON.stringify(errorFile.source, null, 4)
                   .replace(/\n/g, '\\A')
                   .replace(/"/g, '\\"');
                errorFile.source = outputStyleError(errorFile.source, errorFile.path);
                return errorFile;
            });
    }

    /*
    function groupLinkTags(vFile) {
        var tags = /<link .*(?:src|href)=['"]?([\w\.]+)['"]?.*>/g,
            head = /(<\/title>|<meta .*>)|(<\/head>|<body|<script)/,
            links = [];
        vFile.source = vFile.source.replace(tags, function (m) {
            if (links.indexOf(m) === -1) { links.push(m); }
            return '';
        });
        links = links.join('\n');
        vFile.source = vFile.source.replace(head, function (m, after) {
            if (after) {
                m += '\n' + links;
            } else {
                m = links + '\n' + m;
            }
            return m;
        });
        return vFile;
    }
    function mergeInlineScripts(vFile) {
        var tags = /<(script)\b([^>]*)>(?:([\s\S]*?)<\/\1>)?/gmi,
            scripts = [];
        vFile.source = vFile.source.replace(tags, function (m, t, a, content) {
            if (content) {
                content = '(function () { ' + content + '}());';
                if (scripts.indexOf(content) === -1) {
                    scripts.push(content);
                }
                return '';
            }
            return m;
        });
        vFile.source += '<script>' + scripts.join('\n\n') + '</script>';
        return vFile;
    }
    */

    function babelPromise(vFile) {
        return new Promise((resolve, reject) => {
            try {
                vFile.source = babel.transform(vFile.source, {
                    filename: vFile.path,
                    presets: [babelEnv, babelStage3]
                }).code;
                resolve(vFile);
            } catch (e) {
                reject({
                    error: true,
                    path: vFile.path,
                    source: e.message
                });
            }
        });
    }
    function browserifyPromise(vFile) {
        return new Promise(function (resolve, reject) {
            const moduleMatch = /^(?:[ \t]*)?(?:import|export)\b|\brequire\(/gm;
            if (!vFile.source.match(moduleMatch)) return resolve(vFile);
            const src = new stream.Readable(); //eslint-disable-line one-var
            src.push(vFile.source);
            src.push(null);
            src.file = vFile.path;
            browserify(src, {debug: true})
                .transform(babelify, {
                    filename: vFile.path,
                    presets: [babelEnv, babelStage3],
                    global: true
                })
                .bundle(function (err, bundle) {
                    if (err) {
                        return reject({
                            error: true,
                            path: vFile.path,
                            source: err.message
                        });
                    }
                    resolve({path: vFile.path, source: bundle.toString()});
                });
        });
    }
    function processJS(vFile) {
        let promise;
        if (vFile.source.match('module.exports')) {
            // do not process raw modules since those should
            // be included by other file
            return Promise.resolve(vFile);
        }
        if (vFile.source.match(/require\(/)) {
            promise = browserifyPromise(vFile);
        } else {
            promise = babelPromise(vFile);
        }
        return promise.then(replaceEnvVars).catch(function (errorFile) {
            errorFile.source = outputJSError(errorFile.source);
            return errorFile;
        });
    }

    function processInlineScripts(vFile) {
        var stylePattern = /<(style)\b([^>]*)>([\s\S]*?)<\/\1>?/gmi,
            scriptPattern = /<(script)\b([^>]*)>([\s\S]*?)<\/\1>?/gmi,
            vPath = path.parse(vFile.path),
            queue = [];

        function replaceTags(match, tag, attrs, content, index) {
            //SKIP EMPTY TAGS
            if (!content.trim()) { return match; }
            const format = getElementType(attrs) || (tag === 'script' ? 'js' : 'css'),
                iFile = {
                    type: tag,
                    path: path.join(vPath.dir, `${vPath.name}_${tag}_${index}.${format}`),
                    source: content
                },
                //REMOVE LESS TYPE ONCE CONVERTED
                nAttrs = attrs.replace('type=text/less', '');
            //SKIP TRANSPILING LD+JSON SCRIPTS
            if (content && attrs.match(/application\/ld\+json/)) return match;
            queue.push(iFile);
            return match
                .replace(attrs, nAttrs)
                .replace(content, '@{' + iFile.path + '}');
        }
        function next(iFile) {
            return new Promise((resolve) => {
                if (!iFile) { return resolve(vFile); }
                const p = iFile.type === 'style' ? processStyle(iFile) : processJS(iFile);
                p.then((mFile) => {
                    vFile.source = vFile.source.replace(`@{${iFile.path}}`, () => {
                        return mFile.source;
                    });
                    resolve(next(queue.shift()));
                });
            });
        }

        vFile.source = vFile.source.replace(stylePattern, replaceTags);
        vFile.source = vFile.source.replace(scriptPattern, replaceTags);
        return next(queue.shift());
    }
    function processHTML(vFile) {
        return replaceSSI(vFile)
            .then(replaceEnvVars)
            //.then(mergeInlineScripts)
            //.then(groupLinkTags)
            .then(processInlineScripts);
    }

    function getDiff(a, b) {
        const styles = /(<style\b[^>]*>[\s\S]*?<\/style>?)|(<script\b[^>]*>[\s\S]*?<\/script>?)/,
            contentMatch = /<style\b([^>]*)>([\s\S]*?)<\/style>|<script\b[^>]*>([\s\S]*?)<\/script>?/,
            changes = [],
            linesA  = a.split(styles).filter((i) => i),
            linesB  = b.split(styles).filter((i) => i);

        function setChangeType(line) {
            if (!line) { return; }
            let type;
            if (line.match('<script')) {
                type = 'script';
            } else if (line.match('<style')) {
                type = 'style';
            } else {
                type = 'dom';
            }
            return type;
        }
        function getAttributesFromLine(line) {
            if (!line) { return; }
            var match = line.match(contentMatch);
            return match && (match[1] || match[3]);
        }
        function getSourceFromLine(line) {
            if (!line) { return; }
            var match = line.match(contentMatch);
            return match && (match[2] || match[4]);
        }

        function addTypeToChanges(type) {
            if (!changes.type) changes.type = type;
            if (changes.type !== type) changes.type = 'mixed';
            return type;
        }

        function checkChanges(_, index) {
            const original = linesA[index],
                newContent = linesB[index];

            if(newContent !== original) {
                const type = setChangeType(original) || setChangeType(newContent);

                addTypeToChanges(type);

                changes.push({
                    type,
                    was: original,
                    became: newContent,
                    attributes: getAttributesFromLine(newContent),
                    source: getSourceFromLine(newContent)
                });
            }
        }

        //Always analyse the side with more lines
        Array(Math.max(linesA.length,linesB.length))
          .fill().forEach(checkChanges);

        return changes;
    }
    function cachefy(vFile) {
        const broadcast = vFile.broadcast;
        delete vFile.broadcast;
        if (vFile.error) { console.error('FOUND ERROR:', vFile); }
        CACHE[vFile.path] = vFile;
        return !!broadcast;
    }

    function broadcastChanges(vFile) {
        if (!CACHE[vFile.path]) { return vFile; }
        const changes = getDiff(CACHE[vFile.path].source, vFile.source);

        if (!changes.length) { vFile.broadcast = true; }
        if (changes.type === 'style') {
            const format = getElementType(changes[0].attributes) || 'css';
            return processStyle({
                path: vFile.path.replace('.html', '.' + format),
                source: changes[0].source
            }).then((nFile) => {
                this.sockets.emit('css', nFile);
                vFile.broadcast = true;
                return vFile;
            });
        }
        return vFile;
    }
    function onHTMLChange(_eventName, filePath) {
        readFile(filePath)
            .then(processHTML)
            .then(broadcastChanges.bind(this))
            .then(cachefy)
            .then((isBroadcast) => {
                if (!isBroadcast) {
                    const parentPath = CACHE[filePath].parentPath;
                    if (parentPath) {
                        //IF PARENT FILE, PROCESS PARENT
                        return onHTMLChange.bind(this)(null, parentPath);
                    }
                    //WHEN NO MORE PARENT, RELOAD TOPMOST FILE
                    this.reload(filePath);
                }
            })
            .catch(console.error);
    }
    function onJSChange(eventName, filePath) {
        readFile(filePath)
            .then(processJS)
            .then(cachefy)
            .then(() => this.reload(filePath));
    }
    function onStyleChange(eventName, filePath) {
        readFile(filePath)
            .then(processStyle)
            .then(cachefy)
            .then(() => this.reload(filePath));
    }

    const config = {
        browser: 'google chrome',
        open: false,
        online: false,
        notify: false,
        minify: false,
        server: serverPath,
        logFileChanges: true,
        files: [
            {
                options: watcherOpts,
                match: ['**/*.html'],
                fn: onHTMLChange
            },
            {
                options: watcherOpts,
                match: ['**/*.js'],
                fn: onJSChange
            },
            {
                options: watcherOpts,
                match: ['**/*.{css,less}'],
                fn: onStyleChange
            }
        ],
        injectFileTypes: ['css', 'less'],
        middleware: function (req, res, next) {

            var filePath = url.parse(req.url).pathname.replace(/\/$/, '/index.html'),
                fileSrc = path.join(serverPath, filePath),
                fileExt = path.extname(fileSrc) ? path.extname(fileSrc) : '.html',
                cachedVersion = CACHE[fileSrc],
                isDependency = filePath.match(/bower_components|node_modules/),
                isXHR = req.headers['x-requested-with'] === 'XMLHttpRequest';

            if (opts['single-page'] &&  !cachedVersion && fileExt === '.html') {
                try {
                    fs.statSync(fileSrc);
                } catch (_) {
                    cachedVersion = CACHE[opts['single-page']];
                }
            }
            if (isXHR || isDependency || !cachedVersion) return next();

            if (cachedVersion.mimeType) {
                res.setHeader('content-type', cachedVersion.mimeType);
            }
            res.writeHead(200);
            return res.end(cachedVersion.source);
        },
        snippetOptions: {
            rule: {
                match: /$/,
                fn: function (snippet) { return snippet; }
            }
        }
    };

    if (opts.port) { config.port = opts.port; }
    if (opts.ssl) {
        console.log('SETTING HTTPS USING CUSTOM CERTIFICATE');
        console.log(`LOOKING AT ${opts.ssl}.key and ${opts.ssl}.crt`);
        config.https = {
            key:  path.resolve(opts.ssl + '.key'),
            cert: path.resolve(opts.ssl + '.crt')
        };
    }

    bs.init(config);
};
