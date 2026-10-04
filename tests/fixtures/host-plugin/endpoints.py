"""Minimal external-plugin fixture used by the real Mission Control loader."""


def listProjects(body, params, auth):
    return {"ok": True, "handler": "listProjects"}


def getSnapshot(body, params, auth):
    return {"ok": True, "handler": "getSnapshot"}


def getCommitDetail(body, params, auth):
    return {"ok": True, "handler": "getCommitDetail"}


def getPullRequestDetail(body, params, auth):
    return {"ok": True, "handler": "getPullRequestDetail"}


def switchBranch(body, params, auth):
    return {"ok": True, "handler": "switchBranch"}


def createBranch(body, params, auth):
    return {"ok": True, "handler": "createBranch"}


def listTree(body, params, auth):
    return {"ok": True, "handler": "listTree"}


def readFile(body, params, auth):
    return {"ok": True, "handler": "readFile"}


def readFileRaw(body, params, auth):
    return {"ok": True, "handler": "readFileRaw"}


def listPlansTree(body, params, auth):
    return {"ok": True, "handler": "listPlansTree"}


def readPlanFile(body, params, auth):
    return {"ok": True, "handler": "readPlanFile"}
