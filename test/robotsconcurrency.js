/* eslint-env mocha */

// Regression tests for the concurrent robots.txt mode
// (crawler.concurrentRobotsTxt). They use real local HTTP servers so that
// request ordering, in-flight request limits, redirects and aborts are
// exercised end to end.

var chai = require("chai"),
    http = require("http");

var Crawler = require("../");

chai.should();

var makeCrawler = function(url) {
    var crawler = new Crawler(url);

    crawler.interval = 1;
    crawler.concurrentRobotsTxt = true;
    crawler.timeout = 3000;

    return crawler;
};

/**
 * Creates an instrumented HTTP server.
 * @param {Object} routes      Map of URL path to a route function (request, response, server)
 * @param {Object} [sharedStats] Optional object used to track in-flight requests across several servers
 * @return {http.Server}       The instrumented server
 */
function createServer(routes, sharedStats) {
    var stats = sharedStats || {
        active: 0,
        maxActive: 0
    };

    var server = http.createServer(function(request, response) {
        server.requests.push(request.url);

        stats.active += 1;
        if (stats.active > stats.maxActive) {
            stats.maxActive = stats.active;
        }

        var completed = false;

        function complete() {
            if (completed) {
                return;
            }
            completed = true;
            stats.active -= 1;
        }

        response.on("finish", complete);
        response.on("close", complete);
        response.on("error", complete);

        var route = routes[request.url];

        if (!route) {
            response.writeHead(404, {
                "Content-Type": "text/plain",
                "Content-Length": 9
            });
            response.end("Not found");
            return;
        }

        route(request, response, server);
    });

    server.requests = [];
    server.stats = stats;

    return server;
}

function respond(response, status, body, headers) {
    var allHeaders = {
        "Content-Type": "text/html",
        "Content-Length": Buffer.byteLength(body)
    };

    if (headers) {
        Object.keys(headers).forEach(function(header) {
            allHeaders[header] = headers[header];
        });
    }

    response.writeHead(status, allHeaders);
    response.end(body);
}

function delayedRespond(response, delay, body, headers) {
    setTimeout(function() {
        respond(response, 200, body, headers);
    }, delay);
}

function redirect(response, location) {
    response.writeHead(301, {
        "Content-Type": "text/plain",
        "Content-Length": 11,
        "Location": location
    });
    response.end("Redirecting");
}

function redirectTo(location) {
    return function(request, response) {
        redirect(response, location);
    };
}

function countRequests(server, path) {
    return server.requests.filter(function(url) {
        return url === path;
    }).length;
}

describe("Concurrent robots.txt fetching", function() {
    this.slow("500ms");

    it("should be disabled by default", function() {
        var crawler = new Crawler("http://127.0.0.1:3000/");
        crawler.concurrentRobotsTxt.should.equal(false);
    });

    it("should identify origins by protocol, host and effective port", function() {
        var crawler = new Crawler("http://127.0.0.1:3000/");
        crawler._robotsTxtOrigin({
            protocol: "http",
            host: "example.com",
            port: ""
        }).should.equal("http://example.com:80");

        crawler._robotsTxtOrigin({
            protocol: "http",
            host: "example.com",
            port: "80"
        }).should.equal("http://example.com:80");

        crawler._robotsTxtOrigin({
            protocol: "https",
            host: "example.com",
            port: ""
        }).should.equal("https://example.com:443");

        crawler._robotsTxtOrigin({
            protocol: "https",
            host: "example.com",
            port: "443"
        }).should.equal("https://example.com:443");

        crawler._robotsTxtOrigin({
            protocol: "http",
            host: "example.com",
            port: "8080"
        }).should.equal("http://example.com:8080");

        crawler._robotsTxtOrigin({
            protocol: "http",
            host: "example.com",
            port: "443"
        }).should.equal("http://example.com:443");

        crawler._robotsTxtOrigin({
            protocol: "https",
            host: "example.com",
            port: "80"
        }).should.equal("https://example.com:80");

        crawler._robotsTxtURL({
            protocol: "http",
            host: "example.com",
            port: ""
        }).should.equal("http://example.com/robots.txt");

        crawler._robotsTxtURL({
            protocol: "http",
            host: "example.com",
            port: "8080"
        }).should.equal("http://example.com:8080/robots.txt");

        crawler._robotsTxtURL({
            protocol: "https",
            host: "example.com",
            port: "443"
        }).should.equal("https://example.com/robots.txt");

        crawler._robotsTxtURL({
            protocol: "http",
            host: "::1",
            port: "8080"
        }).should.equal("http://[::1]:8080/robots.txt");
    });

    it("should not let a slow robots.txt block other origins", function(done) {
        var order = [];

        var slowServer = createServer({
            "/robots.txt": function(request, response) {
                setTimeout(function() {
                    order.push("slow-robots-response");
                    respond(response, 200, "User-agent: *");
                }, 700);
            },
            "/page-a": function(request, response) {
                respond(response, 200, "Page A");
            },
            "/page-a2": function(request, response) {
                respond(response, 200, "Page A2");
            }
        });

        var fastServer = createServer({
            "/robots.txt": function(request, response) {
                respond(response, 200, "User-agent: *");
            },
            "/page-b": function(request, response) {
                respond(response, 200, "Page B");
            }
        });

        slowServer.listen(3100);
        fastServer.listen(3101);

        var crawler = makeCrawler("http://127.0.0.1:3100/page-a");
        crawler.maxConcurrency = 2;

        // Queue pages on both origins before the first runloop tick. The two
        // pages on the slow origin wait for the same robots.txt probe.
        crawler.on("crawlstart", function() {
            crawler.queueURL("http://127.0.0.1:3100/page-a2");
            crawler.queueURL("http://127.0.0.1:3101/page-b");
        });

        crawler.on("fetchcomplete", function(queueItem) {
            if (queueItem.url === "http://127.0.0.1:3101/page-b") {
                order.push("fast-page-fetched");
            }
        });

        crawler.on("complete", function() {
            // The page on the fast origin was fetched while the slow origin's
            // robots.txt request was still in flight.
            order.should.deep.equal(["fast-page-fetched", "slow-robots-response"]);

            // Both pages of the slow origin waited for a single probe.
            countRequests(slowServer, "/robots.txt").should.equal(1);
            countRequests(fastServer, "/robots.txt").should.equal(1);
            slowServer.requests.length.should.equal(3);

            slowServer.close();
            fastServer.close();
            done();
        });

        crawler.start();
    });

    it("should probe an origin's robots.txt only once", function(done) {
        var server = createServer({
            "/robots.txt": function(request, response) {
                respond(response, 200, "User-agent: *\nAllow: /");
            },
            "/": function(request, response) {
                respond(response, 200, "<a href='/one'>one</a> <a href='/two'>two</a>");
            },
            "/one": function(request, response) {
                respond(response, 200, "<a href='/two'>two</a>");
            },
            "/two": function(request, response) {
                respond(response, 200, "Done");
            }
        });

        server.listen(3110);

        var crawler = makeCrawler("http://127.0.0.1:3110/");

        crawler.on("complete", function() {
            countRequests(server, "/robots.txt").should.equal(1);
            countRequests(server, "/").should.equal(1);
            countRequests(server, "/one").should.equal(1);
            countRequests(server, "/two").should.equal(1);
            crawler._robotsTxts.length.should.equal(1);

            server.close();
            done();
        });

        crawler.start();
    });

    it("should not probe robots.txt when respectRobotsTxt is disabled", function(done) {
        var server = createServer({
            "/robots.txt": function(request, response) {
                respond(response, 200, "User-agent: *\nDisallow: /");
            },
            "/page": function(request, response) {
                respond(response, 200, "Page");
            }
        });

        server.listen(3113);

        var crawler = makeCrawler("http://127.0.0.1:3113/page");
        crawler.respectRobotsTxt = false;

        crawler.on("complete", function() {
            countRequests(server, "/robots.txt").should.equal(0);
            countRequests(server, "/page").should.equal(1);

            server.close();
            done();
        });

        crawler.start();
    });

    it("should wait for asynchronous listeners before completing", function(done) {
        var server = createServer({
            "/robots.txt": function(request, response) {
                respond(response, 200, "User-agent: *");
            },
            "/page": function(request, response) {
                respond(response, 200, "Page");
            }
        });

        server.listen(3112);

        var crawler = makeCrawler("http://127.0.0.1:3112/page"),
            listenerFinished = false;

        crawler.on("fetchcomplete", function() {
            var continueCrawl = this.wait();

            setTimeout(function() {
                listenerFinished = true;
                continueCrawl();
            }, 150);
        });

        crawler.on("complete", function() {
            listenerFinished.should.equal(true);

            server.close();
            done();
        });

        crawler.start();
    });

    it("should apply a disallowed rule to pages that waited for the rules", function(done) {
        var server = createServer({
            "/robots.txt": function(request, response) {
                setTimeout(function() {
                    respond(response, 200, "User-agent: *\nDisallow: /private");
                }, 100);
            },
            "/": function(request, response) {
                respond(response, 200, "<a href='/private'>private</a> <a href='/public'>public</a>");
            },
            "/private": function(request, response) {
                respond(response, 200, "Private");
            },
            "/public": function(request, response) {
                respond(response, 200, "Public");
            }
        });

        server.listen(3111);

        var crawler = makeCrawler("http://127.0.0.1:3111/"),
            disallowed = [];

        crawler.on("fetchdisallowed", function(queueItem) {
            disallowed.push(queueItem.url);
        });

        crawler.on("complete", function() {
            disallowed.should.deep.equal(["http://127.0.0.1:3111/private"]);
            countRequests(server, "/private").should.equal(0);
            countRequests(server, "/public").should.equal(1);

            server.close();
            done();
        });

        crawler.start();
    });

    it("should cap robots.txt probes and page requests together at maxConcurrency", function(done) {
        var stats = {
            active: 0,
            maxActive: 0
        };

        var serverA = createServer({
            "/robots.txt": function(request, response) {
                delayedRespond(response, 120, "User-agent: *");
            },
            "/a": function(request, response) {
                delayedRespond(response, 120, "<a href='/a1'>1</a> <a href='/a2'>2</a> <a href='/a3'>3</a>");
            },
            "/a1": function(request, response) {
                delayedRespond(response, 120, "A1");
            },
            "/a2": function(request, response) {
                delayedRespond(response, 120, "A2");
            },
            "/a3": function(request, response) {
                delayedRespond(response, 120, "A3");
            }
        }, stats);

        var serverB = createServer({
            "/robots.txt": function(request, response) {
                delayedRespond(response, 120, "User-agent: *");
            },
            "/b": function(request, response) {
                delayedRespond(response, 120, "<a href='/b1'>1</a> <a href='/b2'>2</a> <a href='/b3'>3</a>");
            },
            "/b1": function(request, response) {
                delayedRespond(response, 120, "B1");
            },
            "/b2": function(request, response) {
                delayedRespond(response, 120, "B2");
            },
            "/b3": function(request, response) {
                delayedRespond(response, 120, "B3");
            }
        }, stats);

        serverA.listen(3120);
        serverB.listen(3121);

        var crawler = makeCrawler("http://127.0.0.1:3120/a");
        crawler.maxConcurrency = 2;

        crawler.on("crawlstart", function() {
            crawler.queueURL("http://127.0.0.1:3121/b");
        });

        crawler.on("complete", function() {
            // serverA.requests length is 5 (robots + 4 pages) and serverB the
            // same; all eight requests and both probes completed.
            countRequests(serverA, "/robots.txt").should.equal(1);
            countRequests(serverB, "/robots.txt").should.equal(1);
            serverA.requests.length.should.equal(5);
            serverB.requests.length.should.equal(5);

            stats.maxActive.should.be.at.most(2);

            serverA.close();
            serverB.close();
            done();
        });

        crawler.start();
    });

    it("should report one error and keep fetching when robots.txt redirects in a loop", function(done) {
        var server = createServer({
            "/robots.txt": redirectTo("/r1"),
            "/r1": redirectTo("/r2"),
            "/r2": redirectTo("/robots.txt"),
            "/page": function(request, response) {
                respond(response, 200, "Page");
            }
        });

        server.listen(3130);

        var crawler = makeCrawler("http://127.0.0.1:3130/page"),
            errors = [],
            pageFetched = false;

        crawler.on("robotstxterror", function(error) {
            errors.push(error);
        });

        crawler.on("fetchcomplete", function(queueItem) {
            if (queueItem.url === "http://127.0.0.1:3130/page") {
                pageFetched = true;
            }
        });

        crawler.on("complete", function() {
            errors.length.should.equal(1);
            errors[0].message.should.contain("Redirect loop");
            pageFetched.should.equal(true);

            countRequests(server, "/robots.txt").should.equal(1);
            countRequests(server, "/r1").should.equal(1);
            countRequests(server, "/r2").should.equal(1);

            server.close();
            done();
        });

        crawler.start();
    });

    it("should stop after five robots.txt redirects and report only one error", function(done) {
        var routes = {
            "/robots.txt": redirectTo("/r/1")
        };

        for (var redirectNumber = 1; redirectNumber <= 5; redirectNumber++) {
            routes["/r/" + redirectNumber] = redirectTo("/r/" + (redirectNumber + 1));
        }

        routes["/r/6"] = function(request, response) {
            respond(response, 200, "User-agent: *");
        };

        routes["/page"] = function(request, response) {
            respond(response, 200, "Page");
        };

        var server = createServer(routes);
        server.listen(3140);

        var crawler = makeCrawler("http://127.0.0.1:3140/page"),
            errors = [],
            pageFetched = false;

        crawler.on("robotstxterror", function(error) {
            errors.push(error);
        });

        crawler.on("fetchcomplete", function(queueItem) {
            if (queueItem.url === "http://127.0.0.1:3140/page") {
                pageFetched = true;
            }
        });

        crawler.on("complete", function() {
            errors.length.should.equal(1);
            errors[0].message.should.contain("more than 5 redirects");
            pageFetched.should.equal(true);

            // The sixth redirect target must never be requested.
            countRequests(server, "/r/6").should.equal(0);
            server.requests.length.should.equal(7);

            server.close();
            done();
        });

        crawler.start();
    });

    it("should abort probes on stop(true) and resume waiting pages on restart", function(done) {
        var server = createServer({
            "/robots.txt": function(request, response) {
                delayedRespond(response, 600, "User-agent: *\nSitemap: http://127.0.0.1:3150/sitemap.xml");
            },
            "/page": function(request, response) {
                respond(response, 200, "Page");
            },
            "/sitemap.xml": function(request, response) {
                respond(response, 200, "<urlset></urlset>", {
                    "Content-Type": "text/xml"
                });
            }
        });

        server.listen(3150);

        var crawler = makeCrawler("http://127.0.0.1:3150/page"),
            lateEvents = 0,
            pagesFetched = 0;

        crawler.on("robotstxterror", function() {
            lateEvents += 1;
        });

        crawler.on("queueadd", function(queueItem) {
            if (queueItem.url.indexOf("/sitemap.xml") > -1) {
                lateEvents += 1;
            }
        });

        crawler.on("fetchcomplete", function(queueItem) {
            if (queueItem.url.indexOf("/page") > -1) {
                pagesFetched += 1;
            }
        });

        var probeWatcher = setInterval(function() {
            if (countRequests(server, "/robots.txt") < 1) {
                return;
            }

            clearInterval(probeWatcher);
            crawler.stop(true);

            // The server sends its response after 600ms. The aborted probe's
            // late callback must not dispatch pages or queue sitemap links.
            setTimeout(function() {
                lateEvents.should.equal(0);
                pagesFetched.should.equal(0);

                crawler.on("complete", function() {
                    // The origin was probed again after the restart.
                    countRequests(server, "/robots.txt").should.equal(2);
                    pagesFetched.should.equal(1);
                    crawler._robotsTxts.length.should.equal(1);

                    // Only the successful re-probe adds the sitemap URL.
                    lateEvents.should.equal(1);

                    server.close();
                    done();
                });

                crawler.start();
            }, 700);
        }, 5);

        crawler.start();
    });
});
