"use strict";

import fastApply from "fast-apply";
import libUrl from "url";
import urlTransform from "./urlTransform";
import merge from "./utils/merge";
import get from "./utils/get";
import fetchResolver from "./fetchResolver";
import PubSub from "./PubSub";
import createHolder from "./createHolder";

function none() {}

function extractArgs(args) {
  let pathvars;
  let params={};
  let callback;
  if (args[0] instanceof Function) {
    callback = args[0];
  } else if (args[1] instanceof Function) {
    pathvars = args[0];
    callback = args[1];
  } else {
    pathvars = args[0];
    params = args[1];
    callback = args[2] || none;
  }
  return [pathvars, params, callback];
}

function helperCrudFunction(name) {
  return (...args)=> {
    const [pathvars, params, cb] = extractArgs(args);
    return [pathvars, { ...params, method: name.toUpperCase() }, cb];
  };
}

function defaultMiddlewareArgsParser(dispatch, getState) {
  return { dispatch, getState };
}

export const CRUD = ["get", "post", "put", "delete", "patch"].reduce(
  (memo, name)=> {
    memo[name] = helperCrudFunction(name);
    return memo;
  }, {});

/**
 * Constructor for create action
 * @param  {String} url          endpoint's url
 * @param  {String} name         action name
 * @param  {Object} options      action configuration
 * @param  {Object} ACTIONS      map of actions
 * @param  {[type]} fetchAdapter adapter for fetching data
 * @return {Function+Object}     action function object
 */
export default function actionFn(url, name, options, ACTIONS={}, meta={}) {
  const { actionFetch, actionSuccess, actionFail, actionReset } = ACTIONS;
  const pubsub = new PubSub();
  const requestHolder = createHolder();
  const responseHandler = meta && meta.holder && meta.holder.responseHandler;
  /**
   * Fetch data from server
   * @param  {Object}   pathvars    path vars for url
   * @param  {Object}   params      fetch params
   * @param  {Function} getState    helper meta function
  */
  const request = (pathvars, params, getState=none)=> {
    const resultUrlT = urlTransform(url, pathvars, meta.urlOptions);
    const rootUrl = meta.holder ? meta.holder.rootUrl : null;
    let urlT = resultUrlT;
    if (rootUrl) {
      const urlObject = libUrl.parse(urlT);
      if (!urlObject.host) {
        const urlPath = (rootUrl.path ? rootUrl.path.replace(/\/$/, "") : "") +
          "/" + (urlObject.path ? urlObject.path.replace(/^\//, "") : "");
        urlT = `${rootUrl.protocol}//${rootUrl.host}${urlPath}`;
      }
    }
    const globalOptions = !meta.holder ? {} :
      (meta.holder.options instanceof Function) ?
        meta.holder.options(urlT, params, getState) : (meta.holder.options);
    const baseOptions = (options instanceof Function) ?
      options(urlT, params, getState) :
      options;
    const opts = merge({}, globalOptions, baseOptions, params);
    const response = meta.fetch(urlT, opts);
    const result = !meta.validation ? response : response.then(
      data=> new Promise(
        (resolve, reject)=> meta.validation(data,
          err=> err ? reject(err) : resolve(data))));
    if (responseHandler) {
      if (result && result.then) {
        result.then(
          data=> responseHandler(null, data),
          err=> responseHandler(err)
        );
      } else {
        responseHandler(result);
      }
    }
    result && result.catch && result.catch(none);
    return result;
  };

  /**
   * Fetch data from server
   * @param  {Object}   pathvars    path vars for url
   * @param  {Object}   params      fetch params
   * @param  {Function} callback)   callback execute after end request
   */
  function fn(...args) {
    const [pathvars, params, callback] = extractArgs(args);
    const syncing = params ? !!params.syncing : false;
    params && delete params.syncing;
    pubsub.push(callback);
    return (...middlewareArgs)=> {
      const middlewareParser = (meta.holder && meta.holder.middlewareParser) ||
        defaultMiddlewareArgsParser;
      const { dispatch, getState } = middlewareParser(...middlewareArgs);
      const { reducerName, prefix } = meta;
      const state = getState();
      const isLoading = get(state, prefix, reducerName, "loading");
      if (isLoading) {
        return;
      }
      const requestOptions = { pathvars, params };
      const prevData =  get(state, prefix, reducerName, "data");
      dispatch({ type: actionFetch, syncing, request: requestOptions });
      const fetchResolverOpts = {
        dispatch,
        getState,
        actions: meta.actions,
        prefetch: meta.prefetch
      };
      const result = new Promise((done, fail)=> {
        fetchResolver(0, fetchResolverOpts, (err)=> {
          if (err) {
            pubsub.reject(err);
            return fail(err);
          }
          new Promise((resolve, reject)=> {
            requestHolder.set({
              resolve,
              reject,
              promise: request(pathvars, params, getState).then(resolve, reject)
            });
          }).then((d)=> {
            requestHolder.pop();
            const data = meta.transformer(d, prevData, {
              type: actionSuccess, request: requestOptions
            });
            dispatch({
              data,
              origData: d,
              type: actionSuccess,
              syncing: false,
              request: requestOptions
            });
            if (meta.broadcast) {
              meta.broadcast.forEach((type)=> {
                dispatch({ type, data, origData: d, request: requestOptions });
              });
            }
            if (meta.postfetch) {
              meta.postfetch.forEach((postfetch)=> {
                (postfetch instanceof Function) && postfetch({
                  data, getState, dispatch, actions: meta.actions, request: requestOptions
                });
              });
            }
            pubsub.resolve(data);
            done(data);
          }, (error)=> {
            dispatch({ type: actionFail, syncing: false, error, request: requestOptions });
            pubsub.reject(error);
            fail(error);
          });
        });
      });
      result.catch(none);
      return result;
    };
  }

  /*
    Pure rest request
   */
  fn.request = request;

  /**
   * Reset store to initial state
   */
  fn.reset = (mutation)=> {
    const defer = requestHolder.pop();
    defer && defer.reject(new Error("Application abort request"));
    return mutation === "sync" ? { type: actionReset, mutation } : { type: actionReset };
  };

  /**
   * Sync store with server. In server mode works as usual method.
   * If data have already synced, data would not fetch after call this method.
   * @param  {Object} pathvars    path vars for url
   * @param  {Object} params      fetch params
   * @param  {Function} callback) callback execute after end request
   */
  fn.sync = (...args)=> {
    const [pathvars, params, callback] = extractArgs(args);
    const isServer = meta.holder ? meta.holder.server : false;
    return (dispatch, getState)=> {
      const state = getState();
      const store = state[name];
      if (!isServer && store && store.sync) {
        callback(null, store.data);
        return;
      }
      const modifyParams = { ...params, syncing: true };
      return fn(pathvars, modifyParams, callback)(dispatch, getState);
    };
  };

  let helpers = meta.helpers || {};
  if (meta.crud) {
    helpers = { ...CRUD, ...helpers };
  }
  const fnHelperCallback = (memo, func, helpername)=> {
    if (memo[helpername]) {
      throw new Error(
        `Helper name: "${helpername}" for endpoint "${name}" has been already reserved`
      );
    }
    const { sync, call } = (func instanceof Function) ? { call: func } : func;
    memo[helpername] = (...args)=> (dispatch, getState)=> {
      const index = args.length - 1;
      const callbackFn = (args[index] instanceof Function) ? args[index] : none;
      const helpersResult = fastApply(call, { getState, dispatch, actions: meta.actions }, args);
      const result = new Promise((resolve, reject)=> {
        const callback = (err, data)=> {
          err ? reject(err) : resolve(data);
          callbackFn(err, data);
        };
        // If helper alias using async functionality
        if (helpersResult instanceof Function) {
          helpersResult((error, newArgs=[])=> {
            if (error) {
              callback(error);
            } else {
              fastApply(
                sync ? fn.sync : fn, null, newArgs.concat(callback)
              )(dispatch, getState);
            }
          });
        } else {
          // if helper alias is synchronous
          fastApply(
            sync ? fn.sync : fn, null, helpersResult.concat(callback)
          )(dispatch, getState);
        }
      });
      result.catch(none);
      return result;
    };
    return memo;
  };

  return Object.keys(helpers).reduce(
    (memo, key)=> fnHelperCallback(memo, helpers[key], key, helpers), fn);
}
