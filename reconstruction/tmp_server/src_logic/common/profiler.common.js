'use strict';
const co = require('co');
const v8Profiler = require('v8-profiler');
const analysisLib = require('v8-analytics');

module.exports = function (_common, config, logger, utils) {
    /**
     * @param {array} nodes @param {string} key @param {string} value 
     * @description 找到指定 index 的节点
     */
    function catchNode(nodes, key, value) {
        return nodes.filter(item => Number(item[key]) === Number(value))[0];
    }

    /**
     * @param {array} arraySource @param {string} type @param {string} value @param {function} cb
     * @description 内部方法，对获取到的节点进行回调函数注入处理
     */
    function findNode(arraySource, type, value, cb) {
        arraySource.forEach(item => {
            if (item[type] === value) {
                cb(item);
            }
        })
    }

    /**
     * @param {HeapSnapshotWorker.JSHeapSnapshot} jsHeapSnapShot 
     * @param {number} limit
     * @description 柯里化，根据 jsHeapSnapShot 以及 index 的值计算出节点详细属性
     */
    function serializeNode(jsHeapSnapShot, limit) {
        const _cache = {};

        /**
         * @param {number} index
         * @return {object}
         * @description 根据节点索引，得出节点详细信息
         */
        return function (index) {
            let cache = _cache[index];
            //已经计算过的数据缓存起来
            if (cache) return cache;
            //否则调用 serialize 函数序列化数据，并且缓存起来
            cache = analysisLib.serialize(jsHeapSnapShot, index, limit);
            _cache[index] = cache;
            return cache;
        }
    }

    /**
     * @param {object} heapUsed @param {function} serialize @param {array} leakPoint
     * @return {object}
     * @description 解析出引力图所需的数据结构
     */
    function createForceGraph(heapUsed, serialize, leakPoint) {
        //开始进行逻辑处理
        let forceGraphAll = {};
        let leakPointLength = leakPoint.length;
        for (let i = 0; i < leakPointLength; i++) {
            let leak = leakPoint[i];
            let forceGraph = { nodes: [], links: [] };

            let biggestList = {};
            let isRecorded = {};
            let distanceDisplay = 1;
            let distanceLimit = config.profiler.mem.optional.distance_limit;
            let childrenLimit = config.profiler.mem.optional.node_limit;
            let leakDistanceLimit = config.profiler.mem.optional.leak_limit;

            let leakIndexList = [leak.index];
            let rootDistance = serialize(leak.index).distance;
            biggestList[leak.index] = { id: serialize(leak.index).id, source: null, retainedSize: serialize(leak.index).retainedSize };

            while (leakIndexList.length !== 0 && distanceDisplay <= distanceLimit) {
                let tmpIndexArr = [];
                leakIndexList.forEach(index => {
                    let nodeDetail = serialize(index);
                    let children = nodeDetail.children;

                    //去除一部分老的逻辑，加速处理速度以及减小结果体积
                    //tip: child's distance === parent.distance + 1
                    // if (children.length > 100) children = children.slice(0, 100);
                    children = children.filter(item => Boolean(Number(serialize(item.index).distance) === (1 + Number(nodeDetail.distance))));
                    // children.sort((o, n) => Number(serialize(o.index).retainedSize) < Number(serialize(n.index).retainedSize) ? 1 : -1);
                    // children = children.filter((item, index) => index < childrenLimit);

                    //如果该节点已经记录过，直接返回
                    if (isRecorded[nodeDetail.id]) return;
                    isRecorded[nodeDetail.id] = true;

                    //leakPoint 为根节点
                    let isMain = Boolean(leak.index === Number(nodeDetail.index));

                    //设置普通节点颜色和尺寸
                    let size = 30, category = 1, ignore = true, flag = true;
                    //主节点放大
                    if (isMain) { size = 40; category = 0; ignore = false }

                    //存储父节点信息
                    forceGraph.nodes.push({
                        index: nodeDetail.index,
                        name: nodeDetail.id,
                        attributes: { isMain },
                        id: nodeDetail.id,
                        size,
                        category,
                        ignore,
                        flag
                    });

                    //处理父节点对应的子节点
                    children.forEach((child, index) => {
                        let cIndex = child.index;
                        let childDetail = serialize(cIndex);

                        if (!isRecorded[childDetail.id]) {
                            tmpIndexArr.push(cIndex);
                        }

                        //TODO, filter reason
                        if (Math.abs(rootDistance - childDetail.distance) < leakDistanceLimit && biggestList[nodeDetail.index] && childDetail.retainedSize / biggestList[nodeDetail.index].retainedSize > (1 / childrenLimit)) {
                            biggestList[cIndex] = { id: childDetail.id, source: nodeDetail.index, sourceId: nodeDetail.id, distance: childDetail.distance, retainedSize: childDetail.retainedSize };
                        }

                        if (distanceDisplay === distanceLimit) {
                            if (isRecorded[childDetail.id]) return;
                            isRecorded[childDetail.id] = true;

                            let size = 30, category = 1, ignore = true, flag = true;
                            if (distanceDisplay === 2) { ignore = false }

                            forceGraph.nodes.push({
                                index: childDetail.index,
                                name: childDetail.id,
                                attributes: {},
                                id: childDetail.id,
                                size,
                                category,
                                ignore,
                                flag
                            });
                        }

                        forceGraph.links.push({
                            source: nodeDetail.id,
                            target: childDetail.id,
                            sourceIndex: nodeDetail.index,
                            targetIndex: childDetail.index,
                            name_or_index: child.name_or_index
                        });
                    });
                });

                distanceDisplay++;
                leakIndexList = tmpIndexArr;
            }

            forceGraph.nodes.forEach(item => {
                heapUsed[item.index] = serialize(item.index);
            });

            Object.keys(biggestList).forEach(index => {
                let data = catchNode(forceGraph.nodes, 'index', index);
                if (data) {
                    setExpandOff(forceGraph, data);
                }
            });

            forceGraph.nodes.forEach(function (node) {
                node.label = node.name;
                node.symbolSize = node.size;
            });

            forceGraph.index = leak.index;

            const leakDetailTmp = serialize(leak.index);
            forceGraphAll[`${leakDetailTmp.name}::${leakDetailTmp.id}`] = forceGraph;
        }

        return forceGraphAll;
    }

    /**
     * @param {object} forceGraph @param {object} data
     * @description echarts2 设置点击  展开 / 关闭 操作
     */
    function setExpandOff(forceGraph, data) {
        let nodesOption = forceGraph.nodes;
        let linksOption = forceGraph.links;
        let linksNodes = [];

        if (data.flag) {
            for (let m in linksOption) {
                if (linksOption[m].source == data.id) {
                    linksNodes.push(linksOption[m].target);
                }
            }
            if (linksNodes != null && linksNodes != undefined) {
                for (let p in linksNodes) {
                    findNode(nodesOption, 'id', linksNodes[p], node => {
                        node.ignore = false;
                        node.flag = true;
                    });
                }
            }
            findNode(nodesOption, 'id', data.id, node => {
                node.ignore = false;
                node.flag = false;
                node.category = 0;
            });
        } else {
            for (let m in linksOption) {
                if (linksOption[m].source == data.id) {
                    linksNodes.push(linksOption[m].target);
                }
                if (linksNodes != null && linksNodes != undefined) {
                    for (let n in linksNodes) {
                        if (linksOption[m].source == linksNodes[n] && linksOption[m].target != data.id) {
                            linksNodes.push(linksOption[m].target);
                        }
                    }
                }
            }

            if (linksNodes != null && linksNodes != undefined) {
                for (let p in linksNodes) {
                    findNode(nodesOption, 'id', linksNodes[p], node => {
                        node.ignore = true;
                        node.flag = true;
                    });
                }
            }

            findNode(nodesOption, 'id', data.id, node => {
                node.ignore = true;
                node.flag = true;
                node.category = 1;
            });
        }
    }

    /**
     * @param {object} heapUsed @param {function} serialize @param {array} leakPoint @param {number} rootIndex 
     * @description 根据上述方法，计算出最终的 force-graph 引力图计算所需数据
     */
    function memCalculator(heapUsed, serialize, leakPoint, rootIndex) {
        const forceGraph = createForceGraph(heapUsed, serialize, leakPoint);
        const searchList = [{ index: rootIndex }].concat(leakPoint)
        return { forceGraph, searchList };
    }

    /**
     * @param {object} option @param {string} msg @param {object} data
     * @description 模板方法，生成真正的结构化数据
     */
    function template(option, msg, data) {
        data = data || {};
        //组装数据
        const result = {
            "sequence": 0,
            "machineUnique": option.unique,
            "projectName": option.name,
            "processPid": option.pid,
            "loadingMsg": msg,
            "data": data
        };

        return result;
    }

    /**
     * @param {object} params 
     * @description 用于组装 profiler 的 key
     */
    function composeKey(params) {
        const key = {
            pid: params.pid,
            opt: params.opt,
            name: params.name,
            server: params.server,
        }

        return JSON.stringify(key);
    }

    /**
     * @param {string} opt "cpu" 或者 "mem"
     * @param {object} params 
     * @description 根据操作类型执行对应的 profiling 操作
     */
    function profilerP(opt, params) {
        params = params || {};
        if (opt === 'cpu') return cpuProfilerP(params.title);
        if (opt === 'mem') return memProfilerP();
    }

    /**
     * @param {string} title
     * @description 进行 cpu profiling 操作
     */
    function cpuProfilerP(title) {
        return new Promise(resolve => {
            title = title || '';
            v8Profiler.startProfiling(title, true);

            setTimeout(() => {
                const profiler = v8Profiler.stopProfiling(title);
                profiler.delete();
                resolve(profiler);
            }, config.profiler.cpu.profiling_time);
        })
    }

    /**
     * @description 进行 memory profiling 操作
     */
    function memProfilerP() {
        return new Promise((resolve, reject) => {
            const snapshot = v8Profiler.takeSnapshot();

            //废弃方法，改用以下流式读取 heapsnapshot 方式对内存更加友好
            /*snapshot.export(function (error, result) {
                if (error) return reject(error);
                result = typeof result === 'object' && result || utils.jsonParse(result);
                resolve(result);
                snapshot.delete();
            });*/

            //创建 transform 流
            const transform = snapshot.export();
            resolve(transform);
        });
    }

    /**
     * @description 对 profiling 得到的结果进行解析
     */
    function analyticsP(type, profiler, params) {
        return co(_analysysG, type, profiler, params);

        /**
         * @param {string} type @param {object} params @param {object} profiler
         * @description 内部逻辑，处理 profiling 结果解析
         */
        function* _analysysG(type, profiler, params) {
            params = params || {};
            const result = {};

            //解析 cpu-profiler 操作结果
            if (type === 'cpu') {
                const optional = config.profiler.cpu.optional;
                result.timeout = params.timeout || optional.timeout;
                result.longFunctions = analysisLib(profiler, params.timeout || optional.timeout, false, true, { limit: params.long_limit || optional.long_limit }, config.profiler.filter_function);
                result.topExecutingFunctions = analysisLib(profiler, 1, false, true, { limit: params.top_limit || optional.top_limit }, config.profiler.filter_function);
                result.bailoutFunctions = analysisLib(profiler, null, true, true, { limit: params.bail_limit || optional.bail_limit }, config.profiler.filter_function);
            }

            //解析 mem-profiler 操作结果
            if (type === 'mem') {
                const memAnalytics = yield analysisLib.memAnalyticsP(profiler);

                //取出分析结果
                const leakPoint = memAnalytics.leakPoint;
                const rootIndex = memAnalytics.rootIndex;
                let jsHeapSnapShot = memAnalytics.jsHeapSnapShot;

                //根据分析结果初步计算属性
                const statistics = jsHeapSnapShot._statistics;
                const aggregates = jsHeapSnapShot._aggregates.allObjects;

                //节点计算柯里化函数
                const serialize = serializeNode(jsHeapSnapShot, config.profiler.mem.optional.node_limit);

                //TODO
                const heapUsed = leakPoint.reduce((pre, next) => {
                    pre[next.index] = serialize(next.index);
                    return pre;
                }, {});
                //加入 root 节点信息
                heapUsed[rootIndex] = serialize(rootIndex);

                //获取最终分析结果
                const mem_data = memCalculator(heapUsed, serialize, leakPoint, rootIndex);
                const forceGraph = mem_data.forceGraph;
                const searchList = mem_data.searchList.map(item => item.index);

                //释放 jsHeapSnapShot 对象
                jsHeapSnapShot = null;

                //将最终结果填充入结果对象中
                result.heapUsed = heapUsed;
                result.leakPoint = leakPoint;
                result.statistics = statistics;
                result.rootIndex = rootIndex;
                result.aggregates = aggregates;
                result.forceGraph = forceGraph;
                result.searchList = searchList;
            }

            return result;
        }
    }

    return { template, composeKey, profilerP, analyticsP }
}