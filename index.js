/*eslint indent:[1,4]*/
module.exports = function (serverPath) {

    var path         = require('path'),
        fs           = require('fs'),
        url          = require('url'),
        stream       = require('stream'),
        bs           = require('browser-sync').create(),
        less         = require('less'),
        autoprefixer = require('autoprefixer-core'),
        browserify   = require('browserify'),
        regenerator  = require('regenerator'),
        babel        = require('babel-core'),
        babelify     = require('babelify'),
        es2015       = require('babel-preset-es2015'),
        postcss      = require('postcss'),
        marked       = require('marked').setOptions({smartypants: true});

    function replaceMatch(match, newContent) {
        const raw = match[0],
            content = match[3],
            input = match.input,
            index = match.index,
            pre = input.substring(0, index),
            pos = input.substring(index + raw.length);

        //replace through fn to avoid $n substitution
        return pre + raw.replace(content, () => newContent) + pos;
    }

    function outputSource(vFile) { return vFile.source; }
    function outputStyleError(msg) {
        return ''
            + 'html:before {'
            + '  content: "STYLE ERROR: ' + msg + '";'
            + '  position: fixed;'
            + '  font: 1em/1.5 monospace'
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
    function outputJSError(err) {
        var error = err.stack
            .replace(/"/g, '\\"')
            .replace(/\n/g, '\\n');
        return 'console.error("' + error  + '");';
    }

    function autoprefixCSS(vFile) {
        return new Promise((resolve, reject) => {
            try {
                const post = postcss([autoprefixer])
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
                reject(e);
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
            }).catch(reject);
        });
    }
    function processInlineStyles(vFile) {
        var styles = /<(style)\b([^>]*)>(?:([\s\S]*?)<\/\1>)?/gmi,
            vPath = path.parse(vFile.path);

        return new Promise(function (resolve) {
            function check() {
                var styleMatch = styles.exec(vFile.source),
                    styleContent = styleMatch && styleMatch[3],
                    inlineFile;
                if (!styleMatch)   { return resolve(vFile); }
                if (!styleContent) { return check(); }
                inlineFile = {
                    path: path.join(
                        vPath.dir,
                        vPath.name + '_style_' + styleMatch.index + '.css'
                    ),
                    source: styleContent
                };
                autoprefixCSS(inlineFile)
                    .then(function (iFile) {
                        vFile.source = replaceMatch(styleMatch, iFile.source);
                        check();
                    })
                    .catch(function (error) {
                        vFile.source = replaceContent(
                            inlineFile.source,
                            outputStyleError(error.message)
                        );
                        check();
                    });
            }
            check();
        });
    }

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

    function regenerate(vFile) {
        return new Promise((resolve, reject) => {
            try {
                vFile.source = regenerator.compile(vFile.source).code;
                resolve(vFile);
            } catch (e) {
                reject(e);
            }
        });
    }
    function babelPromise(vFile) {
        return new Promise((resolve, reject) => {
            try {
                vFile.source = babel.transform(vFile.source, {
                    filename: vFile.path,
                    presets: [es2015]
                }).code;
                resolve(vFile);
            } catch (e) {
                reject(e);
            }
        });
    }
    function browserifyPromise(vFile) {
        return new Promise(function (resolve, reject) {
            const importMatch = /^(?:\s*)?import\b|\brequire\(/gm;
            if (!vFile.source.match(importMatch)) {
                return resolve(vFile); }
            var src = new stream.Readable();
            src.push(vFile.source);
            src.push(null);
            src.file = vFile.path;
            browserify(src, {debug: true})
                .transform(regenerator)
                .transform(babelify, {
                    filename: vFile.path,
                    presets: [es2015]
                })
                .bundle(function (err, bundle) {
                    if (err) { return reject(err); }
                    resolve({
                        path: vFile.path,
                        source: bundle.toString()
                    });
                });
        });
    }
    function processInlineScripts(vFile) {
        var scripts = /<(script)\b([^>]*)>(?:([\s\S]*?)<\/\1>)?/gmi,
            vPath = path.parse(vFile.path);

        return new Promise(function (resolve) {
            function check() {
                var scriptMatch = scripts.exec(vFile.source),
                    scriptContent = scriptMatch && scriptMatch[3],
                    inlineFile;
                if (!scriptMatch) { return resolve(vFile); }
                if (!scriptContent) { return check(); }

                inlineFile = {
                    path: path.join(
                        vPath.dir,
                        vPath.name + '_script_' + scriptMatch.index + '.js'
                    ),
                    source: scriptContent
                };
                regenerate(inlineFile)
                    .then(babelPromise)
                    .then(browserifyPromise)
                    .then(function (iFile) {
                        vFile.source =
                            replaceMatch(scriptMatch, iFile.source);
                        check();
                    })
                    .catch(function (error) {
                        vFile.source =
                            replaceContent(
                                inlineFile.source, outputJSError(error));
                        check();
                    });
            }
            check();
        });
    }

    function resolveFilePath(fileName, parentName) {
        var dir = path.dirname(parentName);
        fileName = path.join(dir, fileName);
        if (!path.extname(fileName)) {
            return path.join(fileName, 'index.html');
        }
        return fileName;
    }
    function readFile(filePath) {
        return new Promise(function (resolve, reject) {
            function onFile(err, contents) {
                if (err) { return reject(err.message); }
                if (path.extname(filePath).match(/\.(md|mardown|mdown)/)) {
                    contents = marked(contents.toString());
                }
                resolve({
                    path: filePath,
                    source: contents.toString()
                });
            }
            fs.readFile(filePath, onFile);
        });
    }
    function replaceEnvVars(vFile) {
        var pattern = /\$ENV\[['"]?([\w\.\-\/@]+?)['"]?\]/g;
        return new Promise(function (resolve) {
            vFile.source = vFile.source.replace(pattern, function (_, v) {
                return process.env[v] || '';
            });
            resolve(vFile);
        });
    }
    function adjustFilePaths(vFile) {
        var links = /(?:src|href)=['"]?(.+?)['">\s]/g,
            requires = /require\(['"](\..*?)['"]\)/g;
        return new Promise(function (resolve) {
            vFile.source = vFile.source.replace(links, function (m, src) {
                if (src.match(/^(\w+:|#|\/)/)) { return m; }
                var resolved = resolveFilePath(src, vFile.path);
                return m.replace(src, resolved);
            }).replace(requires, function (m, src) {
                var resolved = './' + resolveFilePath(src, vFile.path)
                    .replace('/index.html', '');
                return m.replace(src, resolved);
            });
            resolve(vFile);
        });
    }
    function replaceSSI(vFile) {
        // more http://www.w3.org/Jigsaw/Doc/User/SSI.html#include
        var pattern = /<!--#include file=[\"\']?(.+?)[\"\']? -->/g;
        return new Promise(function (resolve) {
            function check (match) {
                if (!match) { resolve(vFile); }
                readFile(resolveFilePath(match[1], vFile.path))
                    .then(adjustFilePaths)
                    //.then(processInlineScripts)
                    .then(replaceSSI)
                    .then(replaceEnvVars)
                    .then(function ($vFile) {
                        vFile.source = vFile.source
                            .replace(match[0], function () {
                                return $vFile.source;
                            });
                        check(pattern.exec(vFile.source));
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

    bs.init({
        browser: 'google chrome',
        open: false,
        online: false,
        notify: false,
        minify: false,
        server: serverPath,
        files: [
            serverPath + '*.html',
            serverPath + 'lib/**.html',
            serverPath + '*.js',
            serverPath + 'scripts/*.js',
            serverPath + 'lib/**.js',
            {
                options: { ignoreInitial: true },
                match: [
                    serverPath + '*.less',
                    serverPath + '*/*.less',
                    serverPath + 'lib/**.less'
                ],
                fn: function (event) {
                    if (event !== 'change') { return; }
                    //this.reload(path.relative(serverPath, filePath));
                    this.reload('*.less');
                }
            }
        ],
        injectFileTypes: ['less'],
        middleware: function (req, res, next) {
            // It seems there's problem when using BS .then(res.end)
            // creating my own method
            function end(data, statusCode) {
                res.writeHead(statusCode || 200);
                return res.end(data);
            }
            function endCSS(vFile) {
                res.setHeader('content-type', 'text/css');
                res.setHeader('content-length', vFile.source.length);
                res.end(vFile.source);
            }

            var cURL = req.url.replace(/\/$/, '/index.html'),
                filePath = url.parse(cURL).pathname,
                fileSrc = path.join(serverPath, filePath),
                ext = path.extname(filePath),
                f;
            if (filePath.match(/bower_components|node_modules/)) {
                return next();
            }
            if (ext.match(/\.less$/)) {
                return readFile(fileSrc)
                    .catch((e) => { end(e, 404); })
                    .then(lessify)
                    .then(autoprefixCSS)
                    .then(endCSS)
                     .catch(function (error) {
                         console.log("ERROR", error);
                         error = JSON.stringify(error, null, 4)
                            .replace(/\n/g, '\\A')
                            .replace(/"/g, '\\"');
                         res.end(outputStyleError(error));
                     });
            } else if (ext.match(/\.js$/)) {
                if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
                    f = readFile(fileSrc).catch((e) => { end(e, 404); });
                } else {
                    f = readFile(fileSrc)
                        .catch((e) => { end(e, 404); })
                        .then(regenerate)
                        .then(babelPromise)
                        .then(browserifyPromise);
                }
                f.then(replaceEnvVars)
                 .then(outputSource)
                 .then(end)
                 .catch(function (e) {
                     res.end(outputJSError(e)); });
            } else if (ext.match(/\.html$/)) {
                return readFile(fileSrc)
                    .catch((e) => { end(e, 404); })
                    /* MUST PROCESS INLINE SCRIPTS BEFORE SSI IS EXPANDED,
                     * SINCE IT COULD GENERATE ADDITIONAL INLINE SCRIPTS
                     * */
                    .then(replaceSSI)
                    .then(replaceEnvVars)
                    //.then(mergeInlineScripts)
                    //.then(groupLinkTags)
                    .then(processInlineStyles)
                    .then(processInlineScripts)
                    .then(outputSource)
                    .then(end)
                    .catch(end);
            } else {
                next();
            }
        },
        snippetOptions: {
            rule: {
                match: /$/,
                fn: function (snippet) { return snippet; }
            }
        }
    });

};
