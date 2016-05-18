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
        postcss      = require('postcss'),
        marked       = require('marked').setOptions({smartypants: true});

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

    function compileLess(filePath, res) {
        function autoprefix(lessResponse) {
            return postcss([autoprefixer]).process(lessResponse.css, {
                from: path.basename(filePath),
                map: true
            });
        }
        function respond(autoprefixResponse) {
            var css = autoprefixResponse.css;
            if (autoprefix.warnings) {
                autoprefix.warnings().forEach(function (warn) {
                    console.warn(warn.toString());
                });
            }
            res.setHeader('content-type', 'text/css');
            res.setHeader('content-length', css.length);
            res.end(css);
        }
        function onLessfile(err, contents) {
            if (err) { return res.end(err.message); }
            less
                .render(contents.toString(), {
                    filename: filePath,
                    relativeUrls: true,
                    sourceMap: {
                        outputSourceFiles: true,
                        sourceMapBasepath: serverPath,
                        sourceMapFileInline: true
                    }
                })
                .then(autoprefix)
                .then(respond)
                .catch(function (error) {
                    error = JSON.stringify(error, null, 4)
                        .replace(/\n/g, '\\A')
                        .replace(/"/g, '\\"');

                    res.end(outputStyleError(error));
                });
        }
        fs.readFile(filePath, onLessfile);
    }

    function browserifyPromise(vFile) {
        var src = new stream.Readable();
        src.push(vFile.source);
        src.push(null);
        src.file = vFile.path;
        return new Promise(function (resolve, reject) {
            browserify(src, {debug: true})
                .transform(regenerator)
                .bundle(function (err, bundle) {
                    if (err) {
                        console.log('ERROR', err.stack);
                        console.log(vFile.source);
                        return reject(err); }
                    resolve({
                        path: vFile.path,
                        source: bundle.toString()
                    });
                });
        });
    }
    function browserifyInlineScripts(vFile) {
        var scripts = /<(script)\b([^>]*)>(?:([\s\S]*?)<\/\1>)?/gmi,
            vPath = path.parse(vFile.path);

        function replaceContent(original, bundle) {
            return vFile.source.replace(original, function () {
                /*SEND TO FUNCTION SO IT WON'T EVALUATE
                * THINGS LIKE $1 $2 $$ WITHIN CONTENT*/
                return bundle;
            });
        }

        return new Promise(function (resolve) {
            function check() {
                var r = scripts.exec(vFile.source),
                    inlineFile;
                if (!r) { return resolve(vFile); }
                if (!r[3] || !r[3].match(/require\(/)) { return check(); }

                inlineFile = {
                    path: path.join(
                        vPath.dir,
                        vPath.name + '_script_' + r.index + '.js'
                    ),
                    source: r[3]
                };
                browserifyPromise(inlineFile)
                    .then(function (iFile) {
                        vFile.source =
                            replaceContent(inlineFile.source, iFile.source);
                        check();
                    })
                    .catch(function (error) {
                        vFile.source =
                            replaceContent(inlineFile.source, outputJSError(error));
                        check();
                    });
            }
            check();
        });
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
                    //.then(browserifyInlineScripts)
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
        notify: false,
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
            function end(data) { return res.end(data); }

            var cURL = req.url.replace(/\/$/, '/index.html'),
                filePath = url.parse(cURL).pathname,
                fileSrc = path.join(serverPath, filePath),
                ext = path.extname(filePath),
                f;
            if (ext.match(/\.less$/)) {
                return compileLess(fileSrc, res);
            } else if (ext.match(/\.js$/)) {
                if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
                    f = readFile(fileSrc);
                } else {
                    f = readFile(fileSrc)
                        .then(browserifyPromise);
                }
                f.then(replaceEnvVars)
                 .then(outputSource)
                 .then(end)
                 .catch(function (e) {
                     res.end(outputJSError(e)); });
            } else if (ext.match(/\.html$/)) {
                return readFile(fileSrc)
                    /* MUST BROWSERIFY INLINE SCRIPTS BEFORE SSI IS EXPANDED,
                     * SINCE IT COULD GENERATE ADDITIONAL INLINE SCRIPTS
                     * */
                    .then(replaceSSI)
                    .then(replaceEnvVars)
                    .then(mergeInlineScripts)
                    .then(browserifyInlineScripts)
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
