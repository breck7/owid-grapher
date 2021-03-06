import * as React from "react"
import { computed, action, observable } from "mobx"
import { observer } from "mobx-react"
import * as topojson from "topojson-client"

import {
    identity,
    sortBy,
    guid,
    getRelativeMouse,
    minBy,
} from "grapher/utils/Util"
import { Bounds } from "grapher/utils/Bounds"
import { MapProjections, MapProjection } from "./MapProjections"

import { MapTopology } from "./MapTopology"
import { Vector2 } from "grapher/utils/Vector2"
import { worldRegionByMapEntity } from "./WorldRegions"
import { ColorScaleBin } from "grapher/color/ColorScaleBin"

export interface ChoroplethDatum {
    entity: string
    time: number
    value: number | string
    color: string
    highlightFillColor: string
    isSelected?: boolean
}

export interface ChoroplethData {
    [key: string]: ChoroplethDatum
}

export type GeoFeature = GeoJSON.Feature<GeoJSON.GeometryObject>
export type MapBracket = ColorScaleBin

declare type SVGMouseEvent = React.MouseEvent<SVGElement>

export interface MapEntity {
    id: string | number | undefined
    datum:
        | ChoroplethDatum
        | {
              value: string
          }
}

interface ChoroplethMapProps {
    choroplethData: ChoroplethData
    bounds: Bounds
    projection: MapProjection
    defaultFill: string
    focusBracket?: MapBracket
    focusEntity?: MapEntity
    onClick: (d: GeoFeature, ev: SVGMouseEvent) => void
    onHover: (d: GeoFeature, ev: SVGMouseEvent) => void
    onHoverStop: () => void
}

interface RenderFeature {
    id: string
    geo: GeoFeature
    path: string
    bounds: Bounds
    center: Vector2
}

@observer
export class ChoroplethMap extends React.Component<ChoroplethMapProps> {
    base: React.RefObject<SVGGElement> = React.createRef()

    @computed private get uid(): number {
        return guid()
    }

    @computed.struct private get bounds(): Bounds {
        return this.props.bounds
    }

    @computed.struct private get choroplethData(): ChoroplethData {
        return this.props.choroplethData
    }

    @computed.struct private get defaultFill(): string {
        return this.props.defaultFill
    }

    // Get the underlying geographical topology elements we're going to display
    @computed private get geoFeatures(): GeoFeature[] {
        return (topojson.feature(
            MapTopology as any,
            MapTopology.objects.world as any
        ) as any).features
    }

    // The d3 path generator for this projection
    @computed private get pathGen() {
        return MapProjections[this.props.projection]
    }

    // Get the bounding box for every geographical feature
    @computed private get geoBounds() {
        return this.geoFeatures.map((d) => {
            const b = this.pathGen.bounds(d)

            const bounds = Bounds.fromCorners(
                Vector2.fromArray(b[0]),
                Vector2.fromArray(b[1])
            )

            // HACK (Mispy): The path generator calculates weird bounds for Fiji (probably it wraps around the map)
            if (d.id === "Fiji")
                return bounds.extend({
                    x: bounds.right - bounds.height,
                    width: bounds.height,
                })
            else return bounds
        })
    }

    // Combine bounding boxes to get the extents of the entire map
    @computed private get mapBounds(): Bounds {
        return Bounds.merge(this.geoBounds)
    }

    // Get the svg path specification string for every feature
    @computed private get geoPaths() {
        const { geoFeatures, pathGen } = this

        return geoFeatures.map((d) => {
            const s = pathGen(d) as string
            const paths = s.split(/Z/).filter(identity)

            const newPaths = paths.map((path) => {
                const points = path.split(/[MLZ]/).filter((f: any) => f)
                const rounded = points.map((p) =>
                    p
                        .split(/,/)
                        .map((v) => parseFloat(v).toFixed(1))
                        .join(",")
                )
                return "M" + rounded.join("L")
            })

            return newPaths.join("Z") + "Z"
        })
    }

    // Bundle GeoFeatures with the calculated info needed to render them
    @computed private get renderFeatures(): RenderFeature[] {
        return this.geoFeatures.map((geo, i) => ({
            id: geo.id as string,
            geo: geo,
            path: this.geoPaths[i],
            bounds: this.geoBounds[i],
            center: this.geoBounds[i].centerPos,
        }))
    }

    @computed private get focusBracket() {
        return this.props.focusBracket
    }

    @computed private get focusEntity() {
        return this.props.focusEntity
    }

    // Check if a geo entity is currently focused, either directly or via the bracket
    private hasFocus(id: string) {
        const { choroplethData, focusBracket, focusEntity } = this
        if (focusEntity && focusEntity.id === id) return true
        else if (!focusBracket) return false

        const datum = choroplethData[id] || null
        if (focusBracket.contains(datum?.value)) return true
        else return false
    }

    private isSelected(id: string) {
        return this.choroplethData[id].isSelected
    }

    // Viewport for each projection, defined by center and width+height in fractional coordinates
    @computed private get viewport() {
        const viewports = {
            World: { x: 0.565, y: 0.5, width: 1, height: 1 },
            Europe: { x: 0.5, y: 0.22, width: 0.2, height: 0.2 },
            Africa: { x: 0.49, y: 0.7, width: 0.21, height: 0.38 },
            NorthAmerica: { x: 0.49, y: 0.4, width: 0.19, height: 0.32 },
            SouthAmerica: { x: 0.52, y: 0.815, width: 0.1, height: 0.26 },
            Asia: { x: 0.75, y: 0.45, width: 0.3, height: 0.5 },
            Oceania: { x: 0.51, y: 0.75, width: 0.1, height: 0.2 },
        }

        return viewports[this.props.projection]
    }

    // Calculate what scaling should be applied to the untransformed map to match the current viewport to the container
    @computed private get viewportScale() {
        const { bounds, viewport, mapBounds } = this
        const viewportWidth = viewport.width * mapBounds.width
        const viewportHeight = viewport.height * mapBounds.height
        return Math.min(
            bounds.width / viewportWidth,
            bounds.height / viewportHeight
        )
    }

    @computed private get matrixTransform() {
        const { bounds, mapBounds, viewport, viewportScale } = this

        // Calculate our reference dimensions. These values are independent of the current
        // map translation and scaling.
        const mapX = mapBounds.x + 1
        const mapY = mapBounds.y + 1

        // Work out how to center the map, accounting for the new scaling we've worked out
        const newWidth = mapBounds.width * viewportScale
        const newHeight = mapBounds.height * viewportScale
        const boundsCenterX = bounds.left + bounds.width / 2
        const boundsCenterY = bounds.top + bounds.height / 2
        const newCenterX =
            mapX + (viewportScale - 1) * mapBounds.x + viewport.x * newWidth
        const newCenterY =
            mapY + (viewportScale - 1) * mapBounds.y + viewport.y * newHeight
        const newOffsetX = boundsCenterX - newCenterX
        const newOffsetY = boundsCenterY - newCenterY

        const matrixStr = `matrix(${viewportScale},0,0,${viewportScale},${newOffsetX},${newOffsetY})`
        return matrixStr
    }

    // Features that aren't part of the current projection (e.g. India if we're showing Africa)
    @computed private get featuresOutsideProjection() {
        const { projection } = this.props
        return this.renderFeatures.filter(
            (feature) =>
                projection !== "World" &&
                worldRegionByMapEntity[feature.id] !== projection
        )
    }

    @computed private get featuresInProjection() {
        const { projection } = this.props
        return this.renderFeatures.filter(
            (feature) =>
                projection === "World" ||
                worldRegionByMapEntity[feature.id] === projection
        )
    }

    @computed private get featuresWithNoData() {
        return this.featuresInProjection.filter(
            (feature) => !this.choroplethData[feature.id]
        )
    }

    @computed private get featuresWithData() {
        return this.featuresInProjection.filter(
            (feature) => this.choroplethData[feature.id]
        )
    }

    // Map uses a hybrid approach to mouseover
    // If mouse is inside an element, that is prioritized
    // Otherwise we look for the closest center point of a feature bounds, so that we can hover
    // very small countries without trouble

    @observable private hoverEnterFeature?: RenderFeature
    @observable private hoverNearbyFeature?: RenderFeature
    @action.bound private onMouseMove(ev: React.MouseEvent<SVGGElement>) {
        if (ev.shiftKey) this.showSelectedStyle = true // Turn on highlight selection. To turn off, user can switch tabs.
        if (this.hoverEnterFeature) return

        const { featuresInProjection } = this
        const mouse = getRelativeMouse(
            this.base.current!.querySelector(".subunits"),
            ev
        )

        const featuresWithDistance = featuresInProjection.map((d) => {
            return { feature: d, distance: Vector2.distance(d.center, mouse) }
        })

        const feature = minBy(featuresWithDistance, (d) => d.distance)

        if (feature && feature.distance < 20) {
            if (feature.feature !== this.hoverNearbyFeature) {
                this.hoverNearbyFeature = feature.feature
                this.props.onHover(feature.feature.geo, ev)
            }
        } else {
            this.hoverNearbyFeature = undefined
            this.props.onHoverStop()
        }
    }

    @action.bound private onMouseEnter(
        feature: RenderFeature,
        ev: SVGMouseEvent
    ) {
        this.hoverEnterFeature = feature
        this.props.onHover(feature.geo, ev)
    }

    @action.bound private onMouseLeave() {
        this.hoverEnterFeature = undefined
        this.props.onHoverStop()
    }

    @computed private get hoverFeature() {
        return this.hoverEnterFeature || this.hoverNearbyFeature
    }

    @action.bound private onClick(ev: React.MouseEvent<SVGGElement>) {
        if (this.hoverFeature !== undefined)
            this.props.onClick(this.hoverFeature.geo, ev)
    }

    // If true selected countries will have an outline
    @observable private showSelectedStyle = false

    // SVG layering is based on order of appearance in the element tree (later elements rendered on top)
    // The ordering here is quite careful
    render() {
        const {
            uid,
            bounds,
            choroplethData,
            defaultFill,
            matrixTransform,
            viewportScale,
            featuresOutsideProjection,
            featuresWithNoData,
            featuresWithData,
        } = this
        const focusStrokeColor = "#111"
        const focusStrokeWidth = 1.5
        const selectedStrokeWidth = 1
        const blurFillOpacity = 0.2
        const blurStrokeOpacity = 0.5

        return (
            <g
                ref={this.base}
                className="ChoroplethMap"
                clipPath={`url(#boundsClip-${uid})`}
                onMouseDown={
                    (ev: SVGMouseEvent) =>
                        ev.preventDefault() /* Without this, title may get selected while shift clicking */
                }
                onMouseMove={this.onMouseMove}
                onMouseLeave={this.onMouseLeave}
                style={this.hoverFeature ? { cursor: "pointer" } : {}}
            >
                <rect
                    x={bounds.x}
                    y={bounds.y}
                    width={bounds.width}
                    height={bounds.height}
                    fill="rgba(255,255,255,0)"
                    opacity={0}
                />
                <defs>
                    <clipPath id={`boundsClip-${uid}`}>
                        <rect
                            x={bounds.x}
                            y={bounds.y}
                            width={bounds.width}
                            height={bounds.height}
                        ></rect>
                    </clipPath>
                </defs>
                <g className="subunits" transform={matrixTransform}>
                    {featuresOutsideProjection.length && (
                        <g className="nonProjectionFeatures">
                            {featuresOutsideProjection.map((feature) => {
                                return (
                                    <path
                                        key={feature.id}
                                        d={feature.path}
                                        strokeWidth={0.3 / viewportScale}
                                        stroke={"#aaa"}
                                        fill={"#fff"}
                                    />
                                )
                            })}
                        </g>
                    )}

                    {featuresWithNoData.length && (
                        <g className="noDataFeatures">
                            {featuresWithNoData.map((feature) => {
                                const isFocus = this.hasFocus(feature.id)
                                const outOfFocusBracket =
                                    !!this.focusBracket && !isFocus
                                const stroke = isFocus
                                    ? focusStrokeColor
                                    : "#aaa"
                                const fillOpacity = outOfFocusBracket
                                    ? blurFillOpacity
                                    : 1
                                const strokeOpacity = outOfFocusBracket
                                    ? blurStrokeOpacity
                                    : 1
                                return (
                                    <path
                                        key={feature.id}
                                        d={feature.path}
                                        strokeWidth={
                                            (isFocus ? focusStrokeWidth : 0.3) /
                                            viewportScale
                                        }
                                        stroke={stroke}
                                        strokeOpacity={strokeOpacity}
                                        cursor="pointer"
                                        fill={defaultFill}
                                        fillOpacity={fillOpacity}
                                        onClick={(ev: SVGMouseEvent) =>
                                            this.props.onClick(feature.geo, ev)
                                        }
                                        onMouseEnter={(ev) =>
                                            this.onMouseEnter(feature, ev)
                                        }
                                        onMouseLeave={this.onMouseLeave}
                                    />
                                )
                            })}
                        </g>
                    )}

                    {sortBy(
                        featuresWithData.map((feature) => {
                            const isFocus = this.hasFocus(feature.id)
                            const showSelectedStyle =
                                this.showSelectedStyle &&
                                this.isSelected(feature.id)
                            const outOfFocusBracket =
                                !!this.focusBracket && !isFocus
                            const datum = choroplethData[feature.id as string]
                            const stroke =
                                isFocus || showSelectedStyle
                                    ? focusStrokeColor
                                    : "#333"
                            const fill = datum ? datum.color : defaultFill
                            const fillOpacity = outOfFocusBracket
                                ? blurFillOpacity
                                : 1
                            const strokeOpacity = outOfFocusBracket
                                ? blurStrokeOpacity
                                : 1

                            return (
                                <path
                                    key={feature.id}
                                    d={feature.path}
                                    strokeWidth={
                                        (isFocus
                                            ? focusStrokeWidth
                                            : showSelectedStyle
                                            ? selectedStrokeWidth
                                            : 0.3) / viewportScale
                                    }
                                    stroke={stroke}
                                    strokeOpacity={strokeOpacity}
                                    cursor="pointer"
                                    fill={fill}
                                    fillOpacity={fillOpacity}
                                    onClick={(ev: SVGMouseEvent) =>
                                        this.props.onClick(feature.geo, ev)
                                    }
                                    onMouseEnter={(ev) =>
                                        this.onMouseEnter(feature, ev)
                                    }
                                    onMouseLeave={this.onMouseLeave}
                                />
                            )
                        }),
                        (p) => p.props["strokeWidth"]
                    )}
                </g>
            </g>
        )
    }
}
